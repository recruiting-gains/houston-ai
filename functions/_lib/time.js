// Houston (America/Chicago) time helpers. Workers run in UTC, so every wall-clock
// conversion goes through Intl with an explicit time zone.

export const TZ = 'America/Chicago';

const DTF = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const partsCache = new Map(); // formatToParts is the hot path during refresh; cache per second

/** Wall-clock parts of an instant in Houston. */
export function localParts(ms) {
    const key = Math.floor(ms / 1000);
    const hit = partsCache.get(key);
    if (hit) return hit;
    if (partsCache.size > 5000) partsCache.clear();
    const r = computeParts(key * 1000);
    partsCache.set(key, r);
    return r;
}

function computeParts(ms) {
    const p = {};
    for (const part of DTF.formatToParts(new Date(ms))) p[part.type] = part.value;
    return {
        y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second,
        dow: DOW[p.weekday], date: `${p.year}-${p.month}-${p.day}`,
    };
}

/** Offset of Houston from UTC at an instant, in minutes (CDT = -300, CST = -360). */
export function offsetMinutes(ms) {
    const p = localParts(ms);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Houston wall-clock time -> UTC epoch ms (handles DST). */
export function localToMs(y, m, d, h = 0, mi = 0, s = 0) {
    const guess = Date.UTC(y, m - 1, d, h, mi, s);
    let ms = guess - offsetMinutes(guess) * 60000;
    const off2 = offsetMinutes(ms);
    if (guess - off2 * 60000 !== ms) ms = guess - off2 * 60000;
    return ms;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Epoch ms -> "2026-10-03T19:00:00-05:00" in Houston time. */
export function toLocalIso(ms) {
    const p = localParts(ms);
    const off = offsetMinutes(ms);
    const sign = off <= 0 ? '-' : '+';
    const a = Math.abs(off);
    return `${p.date}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** "YYYY-MM-DD HH:MM:SS" (Houston wall clock) -> ms. */
export function parseLocalDateTime(str) {
    const m = String(str || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    return localToMs(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

/** Start of the Houston day containing `ms`, plus `addDays`. */
export function startOfLocalDay(ms, addDays = 0) {
    const p = localParts(ms);
    return localToMs(p.y, p.m, p.d + addDays, 0, 0, 0);
}

export function localDateKey(ms) {
    return localParts(ms).date;
}

const LABEL = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export function humanNow(ms = Date.now()) {
    return `${LABEL.format(new Date(ms))} (Houston time)`;
}

const SHORT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
/** Compact human label for an event's timing, used in the model context. */
export function eventWhen(ev) {
    const s = Date.parse(ev.start);
    const e = ev.end ? Date.parse(ev.end) : null;
    if (ev.ongoing && e) return `ongoing through ${SHORT.format(new Date(e))}`;
    if (ev.all_day) return `${SHORT.format(new Date(s))} (all day)`;
    return `${SHORT.format(new Date(s))} ${TIME.format(new Date(s))}${e && e - s < 86400000 ? `–${TIME.format(new Date(e))}` : ''}`;
}
