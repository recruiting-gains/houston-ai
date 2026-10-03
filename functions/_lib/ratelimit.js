import { HttpError } from './http.js';
import { localDateKey, startOfLocalDay } from './time.js';

export const LIMITS = {
    askPerIp: 10, // questions per IP per Houston day
    refreshFailPerIp: 20, // wrong refresh secrets per IP per day
};

/**
 * Count one hit against `scope:id` for today (Houston calendar day). Throws 429 when the limit is reached.
 * Returns the number of remaining hits after this one. KV is eventually consistent, so limits are approximate.
 */
export async function hit(kv, scope, id, limit, message, now = Date.now()) {
    const key = `rl:${scope}:${id}:${localDateKey(now)}`;
    const used = parseInt((await kv.get(key)) || '0', 10) || 0;
    if (used >= limit) {
        throw new HttpError(429, message || 'Daily limit reached. Please try again tomorrow.', 'rate_limited', {
            limit,
            retryAfter: Math.max(1, Math.ceil((startOfLocalDay(now, 1) - now) / 1000)),
        });
    }
    await kv.put(key, String(used + 1), { expirationTtl: 2 * 24 * 3600 });
    return limit - used - 1;
}

export async function remaining(kv, scope, id, limit, now = Date.now()) {
    const used = parseInt((await kv.get(`rl:${scope}:${id}:${localDateKey(now)}`)) || '0', 10) || 0;
    return Math.max(0, limit - used);
}
