import { json } from '../_lib/http.js';

// Any other /api/* path -> JSON 404
export const onRequest = async () => json({ error: 'Unknown API endpoint.', code: 'not_found' }, 404);
