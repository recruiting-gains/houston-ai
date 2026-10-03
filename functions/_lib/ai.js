import { HttpError } from './http.js';

export const MODELS = {
    primary: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    fallback: '@cf/meta/llama-3.1-8b-instruct',
};
export const CHAT_MODELS = [MODELS.primary, MODELS.fallback];

function extractText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (typeof result.response === 'string') return result.response;
    if (result.response && typeof result.response === 'object') return JSON.stringify(result.response);
    if (result.result && typeof result.result.response === 'string') return result.result.response;
    return '';
}

/** Run a chat completion on Workers AI, trying each model in order until one returns text. */
export async function runChat(ai, messages, { maxTokens = 800, temperature = 0.3, models = CHAT_MODELS } = {}) {
    let lastErr = null;
    for (const model of models) {
        try {
            const result = await ai.run(model, { messages, max_tokens: maxTokens, temperature });
            const text = extractText(result).trim();
            if (text) return { text, model };
            lastErr = new Error(`Empty response from ${model}`);
        } catch (err) {
            lastErr = err;
            console.error(`Workers AI error on ${model}:`, err && err.message ? err.message : err);
        }
    }
    console.error('All Workers AI models failed:', lastErr && lastErr.message);
    throw new HttpError(502, 'The AI is busy right now. Please try again in a moment — or browse the events list below.', 'ai_unavailable');
}

/**
 * Local-dev stand-in for the Workers AI binding (wrangler pages dev can't reach Workers AI without a
 * logged-in account). Only used when MOCK_AI=1 AND the request host is localhost (see api/ask.js).
 */
export function mockAi() {
    return {
        async run(model, { messages }) {
            const ctx = messages.find((m) => m.role === 'user')?.content || '';
            const lines = ctx.split('\n').filter((l) => /^\[E\d+\]/.test(l)).slice(0, 3);
            if (!lines.length) return { response: "I couldn't find matching events in the current listings. Try the browse list below, or ask about a different day." };
            const picks = lines.map((l) => {
                const [head, when, where, price, url] = l.split(' | ');
                return `- **[${head.replace(/^\[E\d+\]\s*/, '')}](${url.replace(/^link:\s*/, '')})** — ${when}, ${where}${price ? ` (${price})` : ''}`;
            });
            return { response: `(mock AI — local dev) Here are a few picks from the listings:\n\n${picks.join('\n')}\n\nAlso try a walk at [Totally Made Up Fest](https://example.com/fake) — check hours before you go.` };
        },
    };
}
