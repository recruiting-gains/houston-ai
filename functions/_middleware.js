// Runs for every path listed in /_routes.json ("include").
// - Hides repository source files that would otherwise be served as static assets.
// - Enforces same-origin for the API (no CORS headers are ever sent).
// - Adds security headers and a JSON error fallback to API responses.

const HIDDEN_PREFIXES = ['/functions/', '/tests/', '/scripts/', '/ops/'];
const HIDDEN_FILES = new Set(['/README.md', '/.gitignore', '/_routes.json', '/package.json', '/package-lock.json', '/wrangler.toml', '/.dev.vars', '/.dev.vars.example']);

function jsonError(status, error, code) {
    return new Response(JSON.stringify({ error, code }), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
}

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const path = url.pathname;

    if (HIDDEN_FILES.has(path) || HIDDEN_PREFIXES.some((p) => path.startsWith(p)) || ['/functions', '/tests', '/scripts', '/ops'].includes(path)) {
        return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (!path.startsWith('/api/') && path !== '/api') return context.next();

    // Same-origin only. Browsers always send Origin on cross-origin requests and on same-origin POST/DELETE.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) {
        return jsonError(403, 'Cross-origin requests are not allowed.', 'forbidden_origin');
    }
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        return jsonError(403, 'Cross-origin requests are not allowed.', 'forbidden_origin');
    }
    if (request.method === 'OPTIONS') {
        return jsonError(403, 'Cross-origin requests are not allowed.', 'forbidden_origin');
    }

    let response;
    try {
        response = await context.next();
    } catch (err) {
        console.error('Unhandled API error:', err && err.stack ? err.stack : err);
        return jsonError(500, 'Something went wrong on our side. Please try again.', 'internal_error');
    }
    response = new Response(response.body, response);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.delete('Access-Control-Allow-Origin');
    return response;
}
