// Run: node --test tests/
// In-memory KV, mock Workers AI, mocked feed HTTP responses. No network, no dependencies.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as askRoute from '../functions/api/ask.js';
import * as eventsRoute from '../functions/api/events.js';
import * as refreshRoute from '../functions/api/refresh.js';
import * as catchAll from '../functions/api/[[path]].js';
import * as middleware from '../functions/_middleware.js';
import { _resetMemo, KV_ALL } from '../functions/_lib/events.js';
import { parseQuery, retrieve } from '../functions/_lib/retrieve.js';
import { enforceLinks } from '../functions/_lib/prompt.js';
import { parsePrice, SOURCES } from '../functions/_lib/sources.js';
import { toLocalIso, localToMs } from '../functions/_lib/time.js';
import { MODELS } from '../functions/_lib/ai.js';

const ORIGIN = 'https://houston-ai.pages.dev';

class MemoryKV {
    constructor() { this.store = new Map(); }
    async get(key, type) {
        const e = this.store.get(key);
        if (!e) return null;
        if (e.exp && e.exp <= Date.now()) { this.store.delete(key); return null; }
        return type === 'json' ? JSON.parse(e.value) : e.value;
    }
    async put(key, value, opts = {}) {
        if (opts.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error('KV minimum TTL is 60s');
        this.store.set(key, { value: String(value), exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null });
    }
    async delete(key) { this.store.delete(key); }
}

// ---- fixtures: one future event per feed type ----
const inDays = (d, h = 19) => {
    const p = toLocalIso(Date.now() + d * 86400000).slice(0, 10).split('-').map(Number);
    return localToMs(p[0], p[1], p[2], h, 0);
};
const ymd = (ms) => toLocalIso(ms).slice(0, 10);
const hm = (ms) => toLocalIso(ms).slice(11, 19);
const utc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const icsUtc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
const mdy = (ms) => { const [y, m, d] = ymd(ms).split('-'); return `${m}/${d}/${y}`; };

const T1 = inDays(1, 19);
const T2 = inDays(2, 10);
function feedFor(url) {
    if (url.includes('/wp-json/tribe/')) {
        const host = new URL(url).host;
        return { json: { events: host.includes('hermannpark') ? [{
            title: 'Sunset Jazz in the Park', url: 'https://hermannpark.org/event/sunset-jazz/', all_day: false,
            start_date: `${ymd(T1)} ${hm(T1)}`, end_date: `${ymd(T1)} 21:00:00`, utc_start_date: utc(T1), utc_end_date: utc(T1 + 2 * 3600000),
            cost: 'Free', categories: [{ name: 'Music' }], excerpt: '<p>Live jazz &amp; picnic blankets.</p>',
            venue: { venue: 'Miller Outdoor Theatre', address: '6000 Hermann Park Dr', city: 'Houston', zip: '77030' },
        }] : [], next_rest_url: null } };
    }
    if (url.includes('calendar.houstonlibrary.org')) {
        return { text: `<rss><channel><item><title>Adult Craft Night</title><link>https://calendar.houstonlibrary.org/event/1</link>
<category>Arts, Crafts &#x26; Hobbies</category><libcal:date>${ymd(T2)}</libcal:date><libcal:start>18:00:00</libcal:start><libcal:end>19:30:00</libcal:end>
<libcal:description>&#x3C;p&gt;Make a candle.&#x3C;/p&gt;</libcal:description><libcal:campus>Heights Neighborhood Library</libcal:campus><libcal:audience>Adults (18+)</libcal:audience></item></channel></rss>` };
    }
    if (url.includes('visithoustontexas.com')) {
        return { text: `<rss><channel><item><title>Big Art Show</title><link>https://www.visithoustontexas.com/event/big-art-show/1/</link>
<category><![CDATA[ Gallery Exhibits ]]></category><category><![CDATA[ Free ]]></category>
<description><![CDATA[ ${mdy(Date.now() - 5 * 86400000)} to ${mdy(Date.now() + 40 * 86400000)} - <p>Paintings.</p> ]]></description></item></channel></rss>` };
    }
    if (url.includes('uhcougars.com')) {
        return { text: ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', `DTSTART:${icsUtc(T1)}`, `DTEND:${icsUtc(T1 + 7200000)}`, 'LOCATION:Houston\\, Texas, Fertitta Center',
            'SUMMARY:University of Houston Volleyball vs BYU', 'URL:https://admin.uhcougars.com/calendar.aspx?game_id=1&amp;sport_id=14', 'END:VEVENT',
            'BEGIN:VEVENT', `DTSTART:${icsUtc(T1)}`, 'LOCATION:Waco\\, Texas', 'SUMMARY:University of Houston Soccer at Baylor', 'URL:https://x', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') };
    }
    if (url.includes('riceowls.com')) return { status: 500, text: 'boom' };
    return { status: 404, text: 'nope' };
}

let fetchCalls;
globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    fetchCalls.push(url);
    const f = feedFor(url);
    const body = f.json ? JSON.stringify(f.json) : f.text;
    return new Response(body, { status: f.status || 200 });
};

let aiCalls;
let aiReply;
const AI = { async run(model, input) { aiCalls.push({ model, input }); return { response: aiReply(input) }; } };

let kv;
let env;
beforeEach(() => {
    kv = new MemoryKV();
    fetchCalls = [];
    aiCalls = [];
    aiReply = () => 'Nothing found.';
    _resetMemo();
    env = { HTX_KV: kv, AI, REFRESH_SECRET: 'super-secret-refresh-key-123', ASSETS: { fetch: async () => new Response('{"updated_at":null,"events":[],"sources":{}}') } };
});

function req(path, { method = 'GET', body, headers = {}, ip = '1.2.3.4' } = {}) {
    const h = new Headers({ 'CF-Connecting-IP': ip, ...headers });
    if (body !== undefined) h.set('Content-Type', 'application/json');
    return new Request(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const call = async (mod, request, e = env) => {
    const res = await mod.onRequest({ request, env: e, params: {}, next: async () => new Response('next') });
    let data = null;
    try { data = await res.clone().json(); } catch { /* not json */ }
    return { res, data };
};
const refresh = (q = '') => call(refreshRoute, req(`/api/refresh?key=super-secret-refresh-key-123${q}`));

// ---------- refresh ----------
test('refresh: requires a configured secret', async () => {
    const { res, data } = await call(refreshRoute, req('/api/refresh?key=x'), { ...env, REFRESH_SECRET: undefined });
    assert.equal(res.status, 503);
    assert.equal(data.code, 'refresh_not_configured');
});

test('refresh: rejects wrong key, accepts header or query key, KV secret fallback', async () => {
    assert.equal((await call(refreshRoute, req('/api/refresh?key=wrong'))).res.status, 401);
    assert.equal((await call(refreshRoute, req('/api/refresh'))).res.status, 401);
    const viaHeader = await call(refreshRoute, req('/api/refresh', { headers: { 'X-Refresh-Key': 'super-secret-refresh-key-123' } }));
    assert.equal(viaHeader.res.status, 200);
    await kv.put('config:refresh_secret', 'kv-stored-secret-abcdefgh');
    const viaKv = await call(refreshRoute, req('/api/refresh?key=kv-stored-secret-abcdefgh'), { ...env, REFRESH_SECRET: undefined });
    assert.equal(viaKv.res.status, 200);
});

test('refresh: failed attempts are rate limited per IP', async () => {
    for (let i = 0; i < 20; i++) await call(refreshRoute, req('/api/refresh?key=nope', { ip: '9.9.9.9' }));
    const { res } = await call(refreshRoute, req('/api/refresh?key=nope', { ip: '9.9.9.9' }));
    assert.equal(res.status, 429);
});

test('refresh: pulls feeds, normalizes, stores in KV, isolates a failing source', async () => {
    const { res, data } = await refresh();
    assert.equal(res.status, 200);
    assert.equal(data.refreshed.rice.ok, false);
    assert.equal(data.refreshed.hermannpark.count, 1);
    assert.equal(data.refreshed.uh.count, 1, 'away games are skipped');
    assert.equal(data.refreshed.hpl.count, 1);
    assert.equal(data.refreshed.visithouston.count, 1);
    const stored = await kv.get(KV_ALL, 'json');
    assert.equal(stored.count, 4);
    const jazz = stored.events.find((e) => e.title === 'Sunset Jazz in the Park');
    assert.equal(jazz.is_free, true);
    assert.equal(jazz.area, 'Museum District');
    assert.equal(jazz.venue, 'Miller Outdoor Theatre');
    assert.match(jazz.start, /^\d{4}-\d{2}-\d{2}T19:00:00-0[56]:00$/);
    const uh = stored.events.find((e) => e.source_id === 'uh');
    assert.equal(uh.url, 'https://uhcougars.com/calendar.aspx?game_id=1&sport_id=14');
    const hpl = stored.events.find((e) => e.source_id === 'hpl');
    assert.equal(hpl.area, 'The Heights');
    assert.equal(hpl.price, 'Free');
    const vh = stored.events.find((e) => e.source_id === 'visithouston');
    assert.equal(vh.ongoing, true);
    for (const ev of stored.events) for (const k of ['title', 'start', 'url', 'source']) assert.ok(ev[k], `${k} present`);
});

test('refresh: single source mode keeps other sources from KV; bad source names rejected', async () => {
    await refresh();
    const one = await refresh('&source=hpl');
    assert.equal(one.res.status, 200);
    assert.deepEqual(Object.keys(one.data.refreshed), ['hpl']);
    assert.equal(one.data.total_events, 4);
    assert.equal((await refresh('&source=nope')).res.status, 400);
});

// ---------- events ----------
test('events: falls back to the committed seed when KV is empty, then serves KV', async () => {
    const seedEnv = { ...env, ASSETS: { fetch: async () => new Response(JSON.stringify({ updated_at: '2026-10-01T00:00:00Z', events: [
        { id: 'a', title: 'Seed Fest', start: toLocalIso(T1), end: null, url: 'https://example.org/seed', source: 'Seed', source_id: 'x', categories: [] },
    ], sources: {} })) } };
    const a = await call(eventsRoute, req('/api/events'), seedEnv);
    assert.equal(a.data.from, 'seed');
    assert.equal(a.data.events[0].title, 'Seed Fest');
    _resetMemo();
    await refresh();
    _resetMemo();
    const b = await call(eventsRoute, req('/api/events?free=1'));
    assert.equal(b.data.from, 'kv');
    assert.ok(b.data.events.every((e) => e.is_free));
    const c = await call(eventsRoute, req('/api/events?q=volleyball'));
    assert.equal(c.data.total, 1);
    assert.ok(Array.isArray(b.data.areas));
});

// ---------- ask ----------
test('ask: cites only listed events and strips invented links', async () => {
    await refresh();
    aiReply = (input) => {
        const ctx = input.messages[1].content;
        assert.match(ctx, /Sunset Jazz in the Park/);
        assert.match(input.messages[0].content, /Houston, Texas ONLY/);
        return 'Try **[Sunset Jazz in the Park](https://hermannpark.org/event/sunset-jazz/)** and [Fake Gala](https://evil.example.com/gala). More: https://evil.example.com/x';
    };
    const { res, data } = await call(askRoute, req('/api/ask', { method: 'POST', body: { question: 'Live music tomorrow night?' } }));
    assert.equal(res.status, 200);
    assert.match(data.answer, /\[Sunset Jazz in the Park\]\(https:\/\/hermannpark\.org\/event\/sunset-jazz\/\)/);
    assert.doesNotMatch(data.answer, /evil\.example\.com/);
    assert.match(data.answer, /Fake Gala/); // label kept as plain text, link removed
    assert.equal(data.events[0].url, 'https://hermannpark.org/event/sunset-jazz/');
    assert.equal(data.remaining_today, 9);
    assert.equal(aiCalls[0].model, MODELS.primary);
});

test('ask: 10 questions per IP per day, then 429', async () => {
    for (let i = 0; i < 10; i++) {
        const { res } = await call(askRoute, req('/api/ask', { method: 'POST', body: { question: 'free stuff?' }, ip: '5.5.5.5' }));
        assert.equal(res.status, 200);
    }
    const { res, data } = await call(askRoute, req('/api/ask', { method: 'POST', body: { question: 'free stuff?' }, ip: '5.5.5.5' }));
    assert.equal(res.status, 429);
    assert.equal(data.code, 'rate_limited');
    assert.ok(res.headers.get('Retry-After'));
    const other = await call(askRoute, req('/api/ask', { method: 'POST', body: { question: 'free stuff?' }, ip: '6.6.6.6' }));
    assert.equal(other.res.status, 200);
    const status = await call(askRoute, req('/api/ask', { ip: '5.5.5.5' }));
    assert.equal(status.data.remaining_today, 0);
});

test('ask: falls back to the smaller model, validates input, needs AI binding', async () => {
    let n = 0;
    const flaky = { async run(model) { n++; if (model === MODELS.primary) throw new Error('capacity'); return { response: 'ok' }; } };
    const r = await call(askRoute, req('/api/ask', { method: 'POST', body: { question: 'anything tonight?' } }), { ...env, AI: flaky });
    assert.equal(r.res.status, 200);
    assert.equal(r.data.model, MODELS.fallback);
    assert.equal(n, 2);
    assert.equal((await call(askRoute, req('/api/ask', { method: 'POST', body: { question: '' } }))).res.status, 400);
    const noAi = await call(askRoute, req('/api/ask', { method: 'POST', body: { question: 'hello there' } }), { ...env, AI: undefined });
    assert.equal(noAi.res.status, 503);
    const prodMock = await call(askRoute, req('/api/ask', { method: 'POST', body: { question: 'hello there' } }), { ...env, AI: undefined, MOCK_AI: '1' });
    assert.equal(prodMock.res.status, 503, 'MOCK_AI is ignored off localhost');
    const local = new Request('http://localhost:8788/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'hello there' }) });
    const mock = await call(askRoute, local, { ...env, AI: undefined, MOCK_AI: '1' });
    assert.equal(mock.res.status, 200);
    assert.ok(mock.data.answer.length > 0);
});

// ---------- units ----------
test('parseQuery: date windows, budget, free, area, topics', () => {
    const sat = localToMs(2026, 10, 3, 14, 0); // Saturday
    const w = parseQuery('date night under $50 this weekend in Montrose', sat);
    assert.equal(w.label, 'this weekend');
    assert.equal(w.maxPrice, 50);
    assert.equal(w.date, true);
    assert.equal(w.area, 'Montrose');
    assert.equal(toLocalIso(w.window.end).slice(0, 10), '2026-10-04');
    const wed = localToMs(2026, 10, 7, 9, 0);
    const w2 = parseQuery("what's on this weekend?", wed);
    assert.equal(toLocalIso(w2.window.start), '2026-10-09T17:00:00-05:00');
    const f = parseQuery('free live music tonight', sat);
    assert.equal(f.free, true);
    assert.ok(f.topics.includes('music'));
    assert.equal(f.evening, true);
});

test('retrieve: respects free + budget filters and windows', () => {
    const base = { categories: [], source: 's', source_id: 's', summary: '' };
    const evs = [
        { ...base, id: '1', title: 'Pricey Gala', start: toLocalIso(T1), url: 'https://a/1', min_price: 200, is_free: false, price: '$200' },
        { ...base, id: '2', title: 'Free Concert', start: toLocalIso(T1), url: 'https://a/2', min_price: 0, is_free: true, price: 'Free', categories: ['Music'] },
        { ...base, id: '3', title: 'Far Future Concert', start: toLocalIso(Date.now() + 60 * 86400000), url: 'https://a/3', min_price: 0, is_free: true },
    ];
    const r = retrieve(evs, parseQuery('concert under $50'));
    assert.deepEqual(r.map((e) => e.id), ['2']);
    assert.deepEqual(retrieve(evs, parseQuery('free things')).map((e) => e.id), ['2']);
});

test('enforceLinks + parsePrice', () => {
    const { text, cited, removed } = enforceLinks('[A](https://ok.example/a) [B](https://bad.example/b) https://ok.example/a', ['https://ok.example/a']);
    assert.equal(removed, 1);
    assert.deepEqual(cited, ['https://ok.example/a']);
    assert.match(text, /^\[A\]\(https:\/\/ok\.example\/a\) B https:\/\/ok\.example\/a$/);
    assert.equal(parsePrice('Free').is_free, true);
    assert.equal(parsePrice('$20 – $35').min_price, 20);
    assert.equal(parsePrice('').is_free, null);
    assert.equal(parsePrice('Free with admission').is_free, null);
    assert.equal(SOURCES.length >= 10, true);
});

// ---------- routing / middleware ----------
test('middleware hides source files and blocks cross-origin API calls', async () => {
    for (const p of ['/README.md', '/functions/api/ask.js', '/scripts/build-seed.mjs', '/wrangler.toml', '/.dev.vars']) {
        const { res } = await call(middleware, req(p));
        assert.equal(res.status, 404, p);
    }
    const x = await call(middleware, req('/api/events', { headers: { Origin: 'https://evil.example' } }));
    assert.equal(x.res.status, 403);
    const ok = await call(middleware, req('/api/events'));
    assert.equal(ok.res.status, 200);
    const nf = await call(catchAll, req('/api/nope'));
    assert.equal(nf.res.status, 404);
});
