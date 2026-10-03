# H-Town AI

A Houston-only AI guide for **events and date ideas**. Static site + Cloudflare Pages Functions, Workers AI and KV.
Deploys by pushing to `main` (Git-connected Pages project, **no build step, output directory = repo root**).

* Answers come from Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, falling back to `@cf/meta/llama-3.1-8b-instruct`) and may
  only mention events from the retrieved listings, linked to their real pages. Any link the model writes that is not an event link
  from the data gets stripped server-side.
* Event data comes from real public Houston feeds (below). It's refreshed into KV by `/api/refresh`. A committed seed
  (`data/seed-events.json`) keeps the site working before the first refresh.

## Layout

| Path | What |
| --- | --- |
| `index.html`, `app.js`, `styles.css`, `theme.js` | Mobile-first single page: chat, quick prompt chips, browsable upcoming events |
| `terms.html`, `privacy.html`, `404.html` | Legal + not-found pages |
| `functions/api/ask.js` | `POST /api/ask` (question → retrieval → Workers AI → answer with cited links), `GET /api/ask` (remaining quota) |
| `functions/api/events.js` | `GET /api/events` browse/filter the stored events |
| `functions/api/refresh.js` | `GET/POST /api/refresh` pull feeds → normalize → KV (secret-protected) |
| `functions/_lib/sources.js` | Feed list + parsers (The Events Calendar REST, LibCal RSS, Simpleview RSS, SIDEARM iCal) |
| `functions/_lib/events.js` | Normalization, 30-day window, de-dupe, repeat collapsing, KV storage, seed fallback |
| `functions/_lib/retrieve.js` | Query parsing (today/tonight/weekend/weekday/month, free, "under $N", area, topics) + ranking |
| `functions/_lib/prompt.js` | Houston system prompt, event context, link guardrail |
| `functions/_lib/{http,ai,ratelimit,time,text,areas}.js` | Shared helpers |
| `functions/_middleware.js` | Same-origin API, security headers, hides repo source files |
| `data/seed-events.json` | Seed dataset generated from the live feeds (`npm run seed`) |
| `scripts/build-seed.mjs` | Regenerates the seed with the exact refresh code path |
| `ops/refresh-workflow.yml` | Optional GitHub Actions schedule for `/api/refresh` (see below) |
| `tests/` | Node tests with mocked KV / Workers AI / feeds |
| `wrangler.toml` | **Reference only** (see note inside: no `pages_build_output_dir`, so Pages ignores it) |

## Data sources

All verified with plain `curl` (no key, no login) and checked against each host's `robots.txt` on 2026-10-03.
Seed generated 2026-10-03 4:50 PM CT, 402 events total. Counts = events stored for the next 30 days in the initial seed (after collapsing same-title repeats to ≤4 per source).

| id | Source | Feed | Seed count |
| --- | --- | --- | --- |
| `hpl` | Houston Public Library | LibCal RSS `calendar.houstonlibrary.org/rss.php?m=month&cid=15272` (≈ next 5 days, 300-item cap) | 163 |
| `visithouston` | Visit Houston | Simpleview RSS `visithoustontexas.com/event/rss/` (30 items, mostly ongoing exhibits/festivals, dates only) | 29 |
| `hermannpark` | Hermann Park Conservancy | The Events Calendar REST `hermannpark.org/wp-json/tribe/events/v1/events` | 8 |
| `buffalobayou` | Buffalo Bayou Partnership | TEC REST `buffalobayou.org/...` | 20 |
| `levypark` | Levy Park | TEC REST `levyparkhouston.org/...` | 36 |
| `memorialpark` | Memorial Park Conservancy | TEC REST `memorialparkconservancy.org/...` | 12 |
| `arboretum` | Houston Arboretum & Nature Center | TEC REST `houstonarboretum.org/...` | 14 |
| `camh` | Contemporary Arts Museum Houston | TEC REST `camh.org/...` | 7 |
| `hmh` | Holocaust Museum Houston | TEC REST `hmh.org/...` | 2 |
| `heights` | Houston Heights Association | TEC REST `houstonheights.org/...` | 10 |
| `midtown` | Midtown Houston | TEC REST `midtownhouston.com/...` | 21 |
| `spacecenter` | Space Center Houston | TEC REST `spacecenter.org/...` (daily presentations; price shown as "Included with admission") | 40 |
| `uh` | Houston Cougars | SIDEARM iCal `uhcougars.com/calendar.ashx/calendar.ics` (home games in Houston only) | 23 |
| `rice` | Rice Owls | SIDEARM iCal `riceowls.com/calendar.ashx/calendar.ics` (home games only) | 17 |

Normalized shape: `{ id, title, start, end, all_day, ongoing, venue, address, area, price, is_free, min_price, url, source, source_id, categories, audience, summary, more_dates? }`
(`start`/`end` are ISO 8601 with the Houston offset; `area` is derived from venue/address/ZIP/library branch and is `null` when unsure).

Tried and **not used**: Discovery Green and Miller Outdoor Theatre (no public feed found), Houston Zoo, MFAH, Menil, HMNS,
Houston Botanic Garden, Market Square/Downtown District (bot challenge), East End District (Sucuri firewall challenge), Eventbrite /
Meetup (need keys / no public feed), ESPN/NBA/MLB data (403, ToS, or off-season), HPL iCal (returns past events only).

## Pages configuration (Settings → Functions / Variables)

| Name | Type | Value |
| --- | --- | --- |
| `AI` | Workers AI binding | your account's Workers AI |
| `HTX_KV` | KV namespace binding | KV namespace named **`houston-ai`** |
| `REFRESH_SECRET` | Environment variable → **Secret** | long random string (≥16 chars), e.g. `openssl rand -hex 24` |
| `ASK_DAILY_CAP` | Environment variable (optional) | global `/api/ask` cap per Houston day, default `400` |

### Refresh secret

`/api/refresh` accepts the key as `?key=…` **or** header `X-Refresh-Key: …` (header preferred: query strings can end up in logs).
The secret is read from the `REFRESH_SECRET` env var, or — if that isn't set — from the KV key `config:refresh_secret` in the
`houston-ai` namespace (you can add it in the dashboard KV UI). Fewer than 16 chars → refresh is disabled (503). Wrong keys get 401
and are limited to 20 attempts per IP per day.

```bash
curl -H "X-Refresh-Key: $SECRET" https://<project>.pages.dev/api/refresh            # all sources
curl "https://<project>.pages.dev/api/refresh?key=$SECRET&source=hpl,uh"              # selected sources
```

A failing source keeps its previous KV copy, so one flaky feed never empties the dataset. Pages Functions have no cron,
so schedule it externally: copy `ops/refresh-workflow.yml` to `.github/workflows/` (calls one source per request), or use any
cron service (cron-job.org, etc.). Without a refresh, the site serves the committed seed (events drop off as they pass).

## API

Same-origin JSON only. Errors: `{ "error": "…", "code": "…" }`.

| Method & path | Body / query | Notes |
| --- | --- | --- |
| `POST /api/ask` | `{ question }` (3–500 chars) | `{ answer (markdown), events[] (cited), cited_count, window, remaining_today, limit, data_updated_at, model }` |
| `GET /api/ask` | – | `{ remaining_today, limit }` |
| `GET /api/events` | `when=today\|tomorrow\|weekend\|week`, `free=1`, `area`, `q`, `source`, `limit` (≤500), `offset` | `{ updated_at, from: kv\|seed, total, events[], areas[], sources[] }` |
| `GET/POST /api/refresh` | `key` or `X-Refresh-Key`, optional `source=a,b` | per-source `{ ok, count, error }` + `total_events` |

### Limits

* 10 questions / IP / Houston calendar day (KV counter `rl:ask:<sha256(ip)>:<date>`), plus global `ASK_DAILY_CAP`.
* KV free tier allows 1,000 writes/day: each question costs 2 writes, a full refresh ~15.

### KV keys

`events:all` (combined dataset) · `src:<id>` (last good copy per source) · `config:refresh_secret` (optional) · `rl:<scope>:<id>:<YYYY-MM-DD>`

## Local development

```bash
cp .dev.vars.example .dev.vars        # REFRESH_SECRET + MOCK_AI=1
npx wrangler@3 pages dev . --kv HTX_KV --port 8788
# MOCK_AI=1 fakes Workers AI, but only for requests to localhost/127.0.0.1 (can never affect production).

npm test        # node --test tests/  (mocked KV, Workers AI and feeds; no network)
npm run seed    # rebuild data/seed-events.json from the live feeds
```
