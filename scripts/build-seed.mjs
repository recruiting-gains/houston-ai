// Build data/seed-events.json from the live feeds using the exact same code the /api/refresh function runs.
// Usage: node scripts/build-seed.mjs   (Node 20+, no dependencies)
import { writeFile } from 'node:fs/promises';
import { fetchSources, combine } from '../functions/_lib/events.js';

const now = Date.now();
const results = await fetchSources(null, now);
const data = combine(results, now);
for (const [id, s] of Object.entries(data.sources)) {
    console.log(`${s.ok ? 'OK  ' : 'FAIL'} ${id.padEnd(14)} ${String(s.count).padStart(4)} events${s.error ? `  (${s.error})` : ''}`);
}
console.log(`Total: ${data.count} events in the next ${data.window_days} days`);
await writeFile(new URL('../data/seed-events.json', import.meta.url), JSON.stringify(data));
console.log('Wrote data/seed-events.json');
