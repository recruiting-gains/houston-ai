// Real Houston event feeds. Every source below was verified to return data with a plain GET,
// needs no API key, and is not disallowed by the host's robots.txt (checked Oct 2026).
// Each fetcher returns normalized events (see normalize() in events.js).

import { decodeEntities, stripHtml, truncate, cleanTitle, xmlTag, xmlTags, rssItems, parseIcs, icsText } from './text.js';
import { localToMs, parseLocalDateTime, toLocalIso, startOfLocalDay } from './time.js';
import { areaFromText, areaFromZip, areaFromHplBranch } from './areas.js';

export const USER_AGENT = 'H-TownAI-EventsBot/0.1 (public event listings; contact: launchgrid.hq@proton.me)';

const tribe = (id, name, base, area, extra = {}) => ({ id, name, type: 'tribe', base, home: base, area, ...extra });

export const SOURCES = [
    { id: 'hpl', name: 'Houston Public Library', type: 'libcal', url: 'https://calendar.houstonlibrary.org/rss.php?m=month&cid=15272', home: 'https://calendar.houstonlibrary.org/' },
    { id: 'visithouston', name: 'Visit Houston', type: 'simpleview', url: 'https://www.visithoustontexas.com/event/rss/', home: 'https://www.visithoustontexas.com/events/' },
    tribe('hermannpark', 'Hermann Park Conservancy', 'https://hermannpark.org', 'Museum District'),
    tribe('buffalobayou', 'Buffalo Bayou Partnership', 'https://buffalobayou.org', 'Buffalo Bayou Park'),
    tribe('levypark', 'Levy Park', 'https://www.levyparkhouston.org', 'Upper Kirby'),
    tribe('memorialpark', 'Memorial Park Conservancy', 'https://www.memorialparkconservancy.org', 'Memorial Park'),
    tribe('arboretum', 'Houston Arboretum & Nature Center', 'https://houstonarboretum.org', 'Memorial Park'),
    tribe('camh', 'Contemporary Arts Museum Houston', 'https://camh.org', 'Museum District'),
    tribe('hmh', 'Holocaust Museum Houston', 'https://hmh.org', 'Museum District'),
    tribe('heights', 'Houston Heights Association', 'https://houstonheights.org', 'The Heights'),
    tribe('midtown', 'Midtown Houston', 'https://midtownhouston.com', 'Midtown'),
    tribe('spacecenter', 'Space Center Houston', 'https://spacecenter.org', 'Clear Lake / NASA', { priceNote: 'Included with admission' }),
    { id: 'uh', name: 'Houston Cougars (UH Athletics)', type: 'sidearm', url: 'https://uhcougars.com/calendar.ashx/calendar.ics', home: 'https://uhcougars.com/calendar', host: 'uhcougars.com' },
    { id: 'rice', name: 'Rice Owls (Rice Athletics)', type: 'sidearm', url: 'https://riceowls.com/calendar.ashx/calendar.ics', home: 'https://riceowls.com/calendar', host: 'riceowls.com' },
];

export const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]));

async function get(url, { timeout = 20000, accept = '*/*' } = {}) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res;
}

// ---------- price helpers ----------
export function parsePrice(raw, { freeHint = false } = {}) {
    const text = stripHtml(raw || '').trim();
    if (!text) return freeHint ? { price: 'Free', is_free: true, min_price: 0 } : { price: null, is_free: null, min_price: null };
    if (/^(free|\$?0(\.00)?)$/i.test(text)) return { price: 'Free', is_free: true, min_price: 0 };
    const nums = [...text.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)|\b(\d+(?:\.\d{1,2})?)\b/g)]
        .map((m) => parseFloat(m[1] || m[2])).filter((n) => Number.isFinite(n));
    const min = nums.length ? Math.min(...nums) : null;
    const conditional = /with (paid )?admission|members|included/i.test(text);
    let isFree = null;
    if (min === 0 || (/\bfree\b/i.test(text) && min === null && !conditional)) isFree = true;
    else if (min !== null && min > 0) isFree = /\bfree\b/i.test(text) ? null : false;
    return { price: truncate(text, 40), is_free: isFree, min_price: isFree ? 0 : min };
}

// ---------- The Events Calendar (WordPress) REST API ----------
async function fetchTribe(src, now, days) {
    const start = toLocalIso(now).slice(0, 10);
    const end = toLocalIso(now + days * 86400000).slice(0, 10);
    let url = `${src.base}/wp-json/tribe/events/v1/events?per_page=50&start_date=${start}&end_date=${end}%2023:59:59`;
    const out = [];
    for (let page = 0; page < 4 && url; page++) {
        const data = await (await get(url, { accept: 'application/json' })).json();
        for (const e of data.events || []) out.push(fromTribe(src, e));
        url = data.next_rest_url || null;
    }
    return out;
}

function fromTribe(src, e) {
    const v = e.venue && typeof e.venue === 'object' && !Array.isArray(e.venue) ? e.venue : null;
    const venueName = v ? cleanTitle(v.venue) : '';
    const address = v ? [v.address, v.city].filter(Boolean).map((x) => decodeEntities(x)).join(', ') : '';
    const startMs = e.utc_start_date ? Date.parse(e.utc_start_date.replace(' ', 'T') + 'Z') : parseLocalDateTime(e.start_date);
    const endMs = e.utc_end_date ? Date.parse(e.utc_end_date.replace(' ', 'T') + 'Z') : parseLocalDateTime(e.end_date);
    const cats = (e.categories || []).map((c) => cleanTitle(c.name)).filter(Boolean);
    const summary = truncate(stripHtml((e.excerpt || e.description || '').slice(0, 900)), 260);
    let price = parsePrice(e.cost, { freeHint: /\bfree\b/i.test(`${e.title} ${cats.join(' ')}`) });
    if (!price.price && src.priceNote) price = { price: src.priceNote, is_free: false, min_price: null };
    const area = areaFromText(`${venueName} ${address}`) || areaFromZip(v && v.zip) || src.area || null;
    return {
        title: cleanTitle(e.title), startMs, endMs, all_day: !!e.all_day, venue: venueName || null, address: address || null,
        area, ...price, url: e.url, categories: cats, summary,
    };
}

// ---------- Houston Public Library (Springshare LibCal RSS) ----------
async function fetchLibcal(src) {
    const xml = await (await get(src.url, { timeout: 30000, accept: 'application/rss+xml' })).text();
    const out = [];
    for (const item of rssItems(xml)) {
        const date = xmlTag(item, 'libcal:date');
        if (!date) continue;
        const [y, m, d] = date.split('-').map(Number);
        const st = xmlTag(item, 'libcal:start');
        const en = xmlTag(item, 'libcal:end');
        const allDay = !st || (/^00:00/.test(st) && (!en || /^00:00/.test(en) || /^23:5\d/.test(en)));
        const [sh, smi] = (st || '0:0').split(':').map(Number);
        const startMs = localToMs(y, m, d, allDay ? 0 : sh, allDay ? 0 : smi);
        let endMs = null;
        if (allDay) endMs = localToMs(y, m, d, 23, 59);
        else if (en) { const [eh, emi] = en.split(':').map(Number); endMs = localToMs(y, m, d, eh, emi); }
        const campus = cleanTitle(xmlTag(item, 'libcal:campus'));
        const room = cleanTitle(xmlTag(item, 'libcal:location'));
        const audience = cleanTitle(xmlTag(item, 'libcal:audience'));
        out.push({
            title: cleanTitle(xmlTag(item, 'title')), startMs, endMs, all_day: allDay,
            venue: campus || 'Houston Public Library', address: room || null,
            area: areaFromHplBranch(campus), price: 'Free', is_free: true, min_price: 0,
            url: decodeEntities(xmlTag(item, 'link')).trim(),
            categories: xmlTags(item, 'category').map(cleanTitle).filter(Boolean), audience: audience || null,
            summary: truncate(stripHtml(xmlTag(item, 'libcal:description').slice(0, 900)), 260),
        });
    }
    return out;
}

// ---------- Visit Houston (Simpleview RSS; ongoing exhibits/festivals, dates only) ----------
async function fetchSimpleview(src) {
    const xml = await (await get(src.url, { accept: 'application/rss+xml' })).text();
    const out = [];
    for (const item of rssItems(xml)) {
        const desc = xmlTag(item, 'description');
        const dates = [...desc.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)].map((m) => [+m[3], +m[1], +m[2]]);
        if (!dates.length) continue;
        const [sy, sm, sd] = dates[0];
        const [ey, em, ed] = dates[dates.length - 1];
        const startMs = localToMs(sy, sm, sd, 0, 0);
        const endMs = localToMs(ey, em, ed, 23, 59);
        const cats = xmlTags(item, 'category').map((c) => cleanTitle(c)).filter(Boolean);
        const title = cleanTitle(xmlTag(item, 'title'));
        const summary = truncate(stripHtml(desc.replace(/<img[^>]*>/gi, '').replace(/\d{2}\/\d{2}\/\d{4}( to)?/g, '').replace(/^\s*-\s*/, '')), 260);
        const free = cats.some((c) => /^free$/i.test(c));
        out.push({
            title, startMs, endMs, all_day: true, venue: null, address: null,
            area: areaFromText(`${title} ${cats.join(' ')}`), price: free ? 'Free' : null, is_free: free ? true : null, min_price: free ? 0 : null,
            url: decodeEntities(xmlTag(item, 'link')).trim(), categories: cats.filter((c) => !/^(free|general)$/i.test(c)), summary,
        });
    }
    return out;
}

// ---------- SIDEARM athletics calendars (home games in Houston only) ----------
function icsDate(prop) {
    if (!prop) return { ms: null, allDay: false };
    const v = prop.value.trim();
    let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m || prop.params.VALUE === 'DATE') {
        m = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
        return { ms: localToMs(+m[1], +m[2], +m[3]), allDay: true };
    }
    m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (!m) return { ms: null, allDay: false };
    if (m[7] === 'Z') return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), allDay: false };
    return { ms: localToMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]), allDay: false }; // floating or TZID=America/Chicago
}

async function fetchSidearm(src) {
    const text = await (await get(src.url, { accept: 'text/calendar' })).text();
    const out = [];
    for (const ev of parseIcs(text)) {
        const summary = icsText(ev.SUMMARY && ev.SUMMARY.value);
        const location = icsText(ev.LOCATION && ev.LOCATION.value);
        if (!/\bvs\.?\s/i.test(summary) || !/houston/i.test(location)) continue; // home games only
        const s = icsDate(ev.DTSTART);
        const e = icsDate(ev.DTEND);
        if (!s.ms) continue;
        const venue = location.replace(/^houston,?\s*(texas|tx)?,?\s*/i, '').trim() || null;
        let url = decodeEntities(icsText(ev.URL && ev.URL.value)).replace('://admin.', '://') || src.home;
        const desc = icsText(ev.DESCRIPTION && ev.DESCRIPTION.value);
        const tickets = desc.match(/Tickets:\s*(https?:\/\/\S+)/i);
        const sport = (summary.match(/(?:University of Houston|Rice)\s+(.+?)\s+vs\.?\s/i) || [])[1] || 'Athletics';
        out.push({
            title: summary.replace(/^\[[A-Z]\]\s*/, ''), startMs: s.ms, endMs: s.allDay ? (e.ms ? e.ms - 60000 : null) : e.ms, all_day: s.allDay,
            venue, address: null, area: areaFromText(`${venue} ${src.name}`) || (src.id === 'uh' ? 'Third Ward' : 'Rice / West U'),
            price: null, is_free: null, min_price: null, url, categories: ['Sports', sport], summary: tickets ? `Tickets: ${tickets[1]}` : '',
        });
    }
    return out;
}

const FETCHERS = { tribe: fetchTribe, libcal: fetchLibcal, simpleview: fetchSimpleview, sidearm: fetchSidearm };

/** Fetch one source and return raw (un-windowed) events. */
export async function fetchSourceRaw(src, now = Date.now(), days = 30) {
    const fn = FETCHERS[src.type];
    if (!fn) throw new Error(`Unknown source type ${src.type}`);
    return fn(src, now, days);
}

export { startOfLocalDay };
