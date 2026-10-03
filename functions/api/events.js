import { route, json } from '../_lib/http.js';
import { loadEvents } from '../_lib/events.js';
import { browseFilter } from '../_lib/retrieve.js';

const clampInt = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

// GET /api/events?when=today|tomorrow|weekend|week&free=1&area=&q=&source=&limit=&offset=
export const onRequest = route({
    GET: async ({ request, env }) => {
        const url = new URL(request.url);
        const p = url.searchParams;
        const data = await loadEvents(env, request);
        const filters = {
            when: (p.get('when') || '').slice(0, 10),
            free: p.get('free') === '1' || p.get('free') === 'true',
            area: (p.get('area') || '').slice(0, 60),
            q: (p.get('q') || '').slice(0, 80),
            source: (p.get('source') || '').slice(0, 30),
        };
        const filtered = browseFilter(data.events, filters);
        const limit = clampInt(p.get('limit'), 60, 1, 500);
        const offset = clampInt(p.get('offset'), 0, 0, 100000);
        const areas = {};
        for (const ev of data.events) if (ev.area) areas[ev.area] = (areas[ev.area] || 0) + 1;
        return json({
            updated_at: data.updated_at,
            from: data.from,
            total: filtered.length,
            offset,
            events: filtered.slice(offset, offset + limit),
            areas: Object.entries(areas).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
            sources: Object.entries(data.sources || {}).map(([id, s]) => ({ id, name: s.name, home: s.home, count: s.count, ok: s.ok })),
        });
    },
});
