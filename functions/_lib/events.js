// Normalization, refresh orchestration and KV storage for Houston events.

import { SOURCES, SOURCE_BY_ID, fetchSourceRaw } from './sources.js';
import { toLocalIso } from './time.js';

export const WINDOW_DAYS = 30;
export const KV_ALL = 'events:all';
export const KV_SRC = (id) => `src:${id}`;
export const SEED_PATH = '/data/seed-events.json';

const MAX_PER_SOURCE = 400;
const MAX_REPEATS = 4; // max kept occurrences of the same title per source (one per day)

/** Fast non-cryptographic id (FNV-1a, 2x32 bits) — refresh must stay cheap on CPU. */
export function eventId(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 16777619);
        h2 = Math.imul(h2 ^ c, 2246822519);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + ((h2 >>> 0) & 0xffff).toString(16).padStart(4, '0');
}

/** Raw fetcher output -> stored event shape, or null if it falls outside [now, now+30d]. */
export function normalize(raw, src, now, days = WINDOW_DAYS) {
    if (!raw || !raw.title || !raw.url || !Number.isFinite(raw.startMs)) return null;
    if (!/^https?:\/\//i.test(raw.url)) return null;
    if (/^\s*(cancel+ed|postponed)\b/i.test(raw.title)) return null;
    const endMs = Number.isFinite(raw.endMs) && raw.endMs >= raw.startMs ? raw.endMs : null;
    const horizon = now + days * 86400000;
    const effectiveEnd = endMs || raw.startMs + 3 * 3600000;
    if (effectiveEnd < now || raw.startMs > horizon) return null;
    const ongoing = !!endMs && endMs - raw.startMs > 36 * 3600000;
    const startIso = toLocalIso(raw.startMs);
    const endIso = endMs ? toLocalIso(endMs) : null;
    // "00:00 -> 23:59" style entries are all-day events, whatever the feed's flag says.
    const allDay = !!raw.all_day || (startIso.slice(11, 16) === '00:00' && !!endIso && /^23:5\d/.test(endIso.slice(11, 16)));
    return {
        id: eventId(`${src.id}|${raw.url}|${raw.startMs}`),
        title: raw.title.slice(0, 200),
        start: startIso,
        end: endIso,
        all_day: allDay,
        ongoing,
        venue: raw.venue || null,
        address: raw.address || null,
        area: raw.area || null,
        price: raw.price || null,
        is_free: raw.is_free === undefined ? null : raw.is_free,
        min_price: Number.isFinite(raw.min_price) ? raw.min_price : null,
        url: raw.url,
        source: src.name,
        source_id: src.id,
        categories: (raw.categories || []).slice(0, 6),
        audience: raw.audience || null,
        summary: raw.summary || '',
    };
}

export async function fetchSource(src, now = Date.now(), days = WINDOW_DAYS) {
    const raw = await fetchSourceRaw(src, now, days);
    const seen = new Set();
    const out = [];
    for (const r of raw) {
        const ev = normalize(r, src, now, days);
        if (!ev) continue;
        const key = `${ev.url}|${ev.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ev);
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    return out.slice(0, MAX_PER_SOURCE);
}

/**
 * Fetch the given sources (default: all) in parallel. Returns
 * { results: { [id]: { ok, count, events, error, fetched_at } } }. Never throws for a single source failure.
 */
export async function fetchSources(ids, now = Date.now()) {
    const list = (ids && ids.length ? ids.map((id) => SOURCE_BY_ID[id]).filter(Boolean) : SOURCES);
    const settled = await Promise.allSettled(list.map((s) => fetchSource(s, now)));
    const results = {};
    settled.forEach((r, i) => {
        const s = list[i];
        const fetched_at = new Date(now).toISOString();
        results[s.id] = r.status === 'fulfilled'
            ? { ok: true, count: r.value.length, events: r.value, error: null, fetched_at }
            : { ok: false, count: 0, events: [], error: String((r.reason && r.reason.message) || r.reason).slice(0, 200), fetched_at };
    });
    return results;
}

/** Merge per-source results into one sorted, de-duplicated dataset. */
export function combine(perSource, now = Date.now()) {
    const events = [];
    const sources = {};
    const seen = new Set();
    for (const s of SOURCES) {
        const r = perSource[s.id];
        if (!r) { sources[s.id] = { name: s.name, home: s.home, ok: false, count: 0, error: 'not fetched yet', fetched_at: null }; continue; }
        let count = 0;
        const perTitle = new Map(); // collapse daily/hourly repeats so one recurring program can't flood the list
        for (const ev of r.events || []) {
            const end = Date.parse(ev.end || ev.start) + (ev.end ? 0 : 3 * 3600000);
            if (end < now) continue;
            const key = `${ev.title.toLowerCase()}|${ev.start.slice(0, 16)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const tKey = ev.title.toLowerCase();
            const g = perTitle.get(tKey) || { days: new Set(), kept: [], extra: 0 };
            perTitle.set(tKey, g);
            const day = ev.start.slice(0, 10);
            if (g.days.has(day) || g.kept.length >= MAX_REPEATS) { g.extra++; continue; }
            g.days.add(day);
            const copy = { ...ev };
            g.kept.push(copy);
            events.push(copy);
            count++;
        }
        for (const g of perTitle.values()) if (g.extra && g.kept.length) g.kept[g.kept.length - 1].more_dates = g.extra;
        sources[s.id] = { name: s.name, home: s.home, ok: !!r.ok, count, error: r.error || null, fetched_at: r.fetched_at || null };
    }
    events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    return { updated_at: new Date(now).toISOString(), window_days: WINDOW_DAYS, count: events.length, sources, events };
}

/**
 * Refresh `ids` (or all sources) into KV. A failed source keeps its previous KV copy, so one flaky
 * feed never empties the dataset.
 */
export async function refreshToKv(kv, ids, now = Date.now()) {
    const fresh = await fetchSources(ids, now);
    const perSource = {};
    await Promise.all(SOURCES.map(async (s) => {
        const f = fresh[s.id];
        if (f && f.ok) {
            perSource[s.id] = f;
            await kv.put(KV_SRC(s.id), JSON.stringify(f));
            return;
        }
        const prev = await kv.get(KV_SRC(s.id), 'json').catch(() => null);
        if (prev) perSource[s.id] = { ...prev, ok: f ? false : prev.ok, error: f ? `${f.error} (kept data from ${prev.fetched_at})` : prev.error };
        else if (f) perSource[s.id] = f;
    }));
    const data = combine(perSource, now);
    await kv.put(KV_ALL, JSON.stringify(data));
    memo = { at: Date.now(), data };
    return { data, fresh };
}

let memo = null; // per-isolate cache to save KV reads
const MEMO_MS = 60 * 1000;

/** Load the dataset: KV first, then the committed seed file (served as a static asset). */
export async function loadEvents(env, request, now = Date.now()) {
    if (memo && Date.now() - memo.at < MEMO_MS) return withLive(memo.data, now);
    let data = null;
    let from = 'kv';
    if (env.HTX_KV) data = await env.HTX_KV.get(KV_ALL, 'json').catch(() => null);
    if (!data) {
        from = 'seed';
        try {
            const url = new URL(SEED_PATH, request.url);
            const res = env.ASSETS ? await env.ASSETS.fetch(url) : await fetch(url);
            if (res.ok) data = await res.json();
        } catch (err) {
            console.error('Seed load failed:', err && err.message);
        }
    }
    if (!data) data = { updated_at: null, count: 0, sources: {}, events: [] };
    data = { ...data, from };
    memo = { at: Date.now(), data };
    return withLive(data, now);
}

function withLive(data, now) {
    const events = data.events.filter((ev) => Date.parse(ev.end || ev.start) + (ev.end ? 0 : 3 * 3600000) >= now);
    return { ...data, events };
}

export function _resetMemo() { memo = null; }
