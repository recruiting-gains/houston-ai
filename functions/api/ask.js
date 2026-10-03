import { route, json, readJson, requireBindings, cleanString, clientIp, sha256Hex, HttpError } from '../_lib/http.js';
import { runChat, mockAi } from '../_lib/ai.js';
import { hit, remaining, LIMITS } from '../_lib/ratelimit.js';
import { loadEvents } from '../_lib/events.js';
import { parseQuery, retrieve } from '../_lib/retrieve.js';
import { systemPrompt, userMessage, enforceLinks } from '../_lib/prompt.js';

const CARD_FIELDS = ['id', 'title', 'start', 'end', 'all_day', 'ongoing', 'venue', 'area', 'price', 'is_free', 'url', 'source', 'more_dates'];
const card = (ev) => Object.fromEntries(CARD_FIELDS.map((k) => [k, ev[k] ?? null]));

// MOCK_AI=1 only takes effect on localhost (wrangler pages dev), so it can never shadow Workers AI in production.
function aiBinding(env, request) {
    const host = new URL(request.url).hostname;
    if (env.MOCK_AI === '1' && (host === 'localhost' || host === '127.0.0.1')) return mockAi();
    return env.AI || null;
}

// GET /api/ask -> { remaining_today, limit }
// POST /api/ask { question } -> { answer, events[], remaining_today, window, data_updated_at }
export const onRequest = route({
    GET: async ({ request, env }) => {
        requireBindings(env, ['HTX_KV']);
        const ipId = await sha256Hex(`ip:${clientIp(request)}`);
        return json({ remaining_today: await remaining(env.HTX_KV, 'ask', ipId, LIMITS.askPerIp), limit: LIMITS.askPerIp });
    },
    POST: async ({ request, env }) => {
        requireBindings(env, ['HTX_KV']);
        const ai = aiBinding(env, request);
        if (!ai) requireBindings(env, ['AI']);
        const body = await readJson(request);
        const question = cleanString(body.question, 'question', { min: 3, max: 500 });

        const ipId = await sha256Hex(`ip:${clientIp(request)}`);
        const remainingToday = await hit(env.HTX_KV, 'ask', ipId, LIMITS.askPerIp,
            `You've used your ${LIMITS.askPerIp} questions for today. They reset at midnight Houston time — meanwhile, browse the events list below.`);
        const cap = parseInt(env.ASK_DAILY_CAP || '400', 10) || 400;
        await hit(env.HTX_KV, 'askall', 'global', cap, 'H-Town AI is taking a breather after a busy day. Please try again tomorrow — the events list still works.');

        const now = Date.now();
        const data = await loadEvents(env, request, now);
        const intent = parseQuery(question, now);
        let events = retrieve(data.events, intent, { limit: 18, now });
        if (events.length < 3 && intent.area) events = retrieve(data.events, { ...intent, area: null }, { limit: 18, now });

        const { text, model } = await runChat(ai, [
            { role: 'system', content: systemPrompt(now) },
            { role: 'user', content: userMessage(question, events, intent) },
        ], { maxTokens: 700, temperature: 0.3 });

        const { text: answer, cited, removed } = enforceLinks(text, events.map((e) => e.url));
        if (removed) console.warn(`ask: removed ${removed} non-listed link(s) from model output`);
        const byUrl = new Map(events.map((e) => [e.url, e]));
        // Cards under the answer: the events it actually cited, or (if none) the closest matches.
        const cards = cited.length ? cited.map((u) => byUrl.get(u)).filter(Boolean) : events.slice(0, 4);

        if (!answer) throw new HttpError(502, 'The AI returned an empty answer. Please try again.', 'ai_empty');
        return json({
            answer,
            events: cards.slice(0, 8).map(card),
            cited_count: cited.length,
            window: intent.label,
            remaining_today: remainingToday,
            limit: LIMITS.askPerIp,
            data_updated_at: data.updated_at,
            model,
        });
    },
});
