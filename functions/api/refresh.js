import { route, json, requireBindings, clientIp, sha256Hex, HttpError } from '../_lib/http.js';
import { hit, LIMITS } from '../_lib/ratelimit.js';
import { refreshToKv } from '../_lib/events.js';
import { SOURCE_BY_ID } from '../_lib/sources.js';

export const KV_SECRET = 'config:refresh_secret';

async function checkSecret(request, env) {
    const configured = (env.REFRESH_SECRET || (await env.HTX_KV.get(KV_SECRET)) || '').trim();
    if (configured.length < 16) {
        throw new HttpError(503, 'Refresh is not configured: set REFRESH_SECRET (16+ chars) as an env var or the KV key config:refresh_secret.', 'refresh_not_configured');
    }
    const url = new URL(request.url);
    const given = (request.headers.get('X-Refresh-Key') || url.searchParams.get('key') || '').trim();
    // Compare digests so the comparison time doesn't depend on how many leading characters match.
    const ok = given.length > 0 && (await sha256Hex(`k:${given}`)) === (await sha256Hex(`k:${configured}`));
    if (!ok) {
        const ipId = await sha256Hex(`ip:${clientIp(request)}`);
        await hit(env.HTX_KV, 'refreshfail', ipId, LIMITS.refreshFailPerIp, 'Too many failed refresh attempts today.');
        throw new HttpError(401, 'Missing or wrong refresh key.', 'unauthorized');
    }
}

async function handle({ request, env }) {
    requireBindings(env, ['HTX_KV']);
    await checkSecret(request, env);
    const url = new URL(request.url);
    const raw = (url.searchParams.get('source') || '').trim();
    let ids = null;
    if (raw) {
        ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
        const bad = ids.filter((id) => !SOURCE_BY_ID[id]);
        if (bad.length) throw new HttpError(400, `Unknown source(s): ${bad.join(', ')}. Valid: ${Object.keys(SOURCE_BY_ID).join(', ')}`, 'validation_error');
    }
    const started = Date.now();
    const { data, fresh } = await refreshToKv(env.HTX_KV, ids);
    return json({
        ok: Object.values(fresh).every((r) => r.ok),
        refreshed: Object.fromEntries(Object.entries(fresh).map(([id, r]) => [id, { ok: r.ok, count: r.count, error: r.error }])),
        total_events: data.count,
        updated_at: data.updated_at,
        ms: Date.now() - started,
    });
}

// GET or POST /api/refresh?key=SECRET[&source=hpl,uh]   (or header X-Refresh-Key: SECRET)
export const onRequest = route({ GET: handle, POST: handle });
