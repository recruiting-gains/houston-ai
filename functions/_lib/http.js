// Shared HTTP helpers for H-Town AI Pages Functions.
// NOTE: helper modules must never export anything named onRequest* (Pages would route them).

export class HttpError extends Error {
    constructor(status, message, code, extra) {
        super(message);
        this.status = status;
        this.code = code || 'error';
        this.extra = extra || {};
    }
}

const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
};

export function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function errorResponse(err) {
    if (err instanceof HttpError) {
        const headers = {};
        if (err.extra.retryAfter) headers['Retry-After'] = String(err.extra.retryAfter);
        const body = { error: err.message, code: err.code };
        for (const [k, v] of Object.entries(err.extra)) if (k !== 'retryAfter') body[k] = v;
        return json(body, err.status, headers);
    }
    console.error('Unhandled error:', err && err.stack ? err.stack : err);
    return json({ error: 'Something went wrong on our side. Please try again.', code: 'internal_error' }, 500);
}

/**
 * Build a Pages Functions handler that dispatches by HTTP method and turns
 * thrown HttpErrors into JSON responses.
 */
export function route(handlers) {
    const allowed = Object.keys(handlers).join(', ');
    return async (context) => {
        try {
            const method = context.request.method.toUpperCase();
            const handler = handlers[method];
            if (!handler) {
                return json({ error: `Method not allowed. Use ${allowed}.`, code: 'method_not_allowed' }, 405, { Allow: allowed });
            }
            return await handler(context);
        } catch (err) {
            return errorResponse(err);
        }
    };
}

const MAX_BODY_BYTES = 32 * 1024;

/** Parse a JSON object body with size + content-type checks. */
export async function readJson(request) {
    const type = (request.headers.get('Content-Type') || '').toLowerCase();
    if (!type.startsWith('application/json')) {
        throw new HttpError(415, 'Send the request body as JSON (Content-Type: application/json).', 'unsupported_media_type');
    }
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.', 'payload_too_large');
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
        throw new HttpError(413, 'Request body is too large.', 'payload_too_large');
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new HttpError(400, 'Request body is not valid JSON.', 'invalid_json');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new HttpError(400, 'Request body must be a JSON object.', 'invalid_json');
    }
    return data;
}

/** Validate and normalise a user-supplied string. */
export function cleanString(value, field, { min = 1, max = 1000, required = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw new HttpError(400, `"${field}" is required.`, 'validation_error', { field });
        return '';
    }
    if (typeof value !== 'string') throw new HttpError(400, `"${field}" must be a string.`, 'validation_error', { field });
    // Strip control characters except newline and tab, normalise line endings.
    const s = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (s.length < min) {
        if (!required && s.length === 0) return '';
        throw new HttpError(400, `"${field}" must be at least ${min} characters.`, 'validation_error', { field });
    }
    if (s.length > max) throw new HttpError(400, `"${field}" must be at most ${max} characters.`, 'validation_error', { field });
    return s;
}

export function clientIp(request) {
    return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || '0.0.0.0';
}

export async function sha256Hex(input) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fail fast with a clear message when a Pages binding has not been added yet. */
export function requireBindings(env, names) {
    const missing = names.filter((n) => !env || !env[n]);
    if (missing.length) {
        throw new HttpError(
            503,
            `H-Town AI is still being set up: missing ${missing.join(' and ')} binding${missing.length > 1 ? 's' : ''}. Please try again later.`,
            'not_configured',
            { missing },
        );
    }
}
