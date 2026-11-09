# Durable Crikora scraper

## What is now implemented

- The 4,721-URL sitemap inventory is loaded by the API and filtered through a strict HTTPS `www.cricbuzz.com` path allowlist.
- Each URL is stored as queue metadata in Neon. URL jobs use leases and can be reclaimed after a worker restart.
- The crawler parses a page through the existing Cricbuzz provider, stores its normalized entity in `crikora_cache`, and follows further allowlisted links.
- Match overview, facts, squads and scorecard URLs have distinct classification. The allowlist explicitly accepts match facts and squad paths.
- HTTP 429 honors `Retry-After`; transient failures back off and retry. HTTP 401/403 and redirects pause the run rather than trying to bypass the source response.
- The worker drains the full-crawl queue before returning to normal live/upcoming/recent refreshes.
- The live refresh process also forwards unprocessed related links into the persistent queue.
- Scraped payloads stay in the existing cache and expire after 600 seconds. The queue keeps only URL, progress, lease and error metadata.

## Database migrations

Apply migrations `001` through `004` to the production Neon branch in order. Migration `004_crikora_durable_crawl.sql` creates the run and URL queue tables. It is additive and does not alter or delete existing cache rows.

## API routes

The API base URL ends in `/api`.

| Method | Route | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/health` | Public | API, database and secret-presence health |
| `POST` | `/crawl/start` | `CRIKORA_ADMIN_SECRET` | Seed or resume the sitemap crawl |
| `GET` | `/crawl/status` | `CRIKORA_ADMIN_SECRET` | Inspect crawl progress and errors |
| `POST` | `/crawl/step` | `CRIKORA_REFRESH_SECRET` | Process a bounded queue batch (worker only) |
| `POST` | `/cleanup` | `CRIKORA_REFRESH_SECRET` | Run expired-cache deletion |

The worker management route `POST /v1/crawl/start` starts or resumes the core crawl and launches the durable workflow. Use the worker's `CRIKORA_WORKER_ADMIN_SECRET` as the bearer token for that route.

## Environment variables

### API / core project

Required:
- `DATABASE_URL`
- `CRIKORA_ADMIN_SECRET`
- `CRIKORA_REFRESH_SECRET`
- `CRICBUZZ_AUTOMATION_AUTHORIZED=true` only after source authorization and the deployment are ready

Optional crawl controls:
- `CRIKORA_CRAWL_BATCH_SIZE=2` (allowed values: 1 to 3)
- `CRIKORA_CRAWL_MAX_ATTEMPTS=4` (allowed values: 1 to 8)
- Existing `CRICBUZZ_*` limits, timeout, response-size and request-interval controls

### Worker project

Required:
- `CRIKORA_API_BASE_URL` (for example `https://crikora.vercel.app/api`)
- `DATABASE_URL` for the same Neon production branch
- `CRIKORA_REFRESH_SECRET` (same value as the core API)
- `CRIKORA_ADMIN_SECRET` (same value as the core API)
- `CRIKORA_WORKER_ADMIN_SECRET`

Do not put any of these secrets in the browser extension, website bundle, repository, issue text or logs.

## Full crawl operation

1. Apply migrations 001-004 to Neon production.
2. Configure the required core and worker environment variables in their respective hosting projects.
3. Keep automation disabled until the deployment health check confirms that the core API can reach the same Neon production branch and the worker is ready.
4. Set `CRICBUZZ_AUTOMATION_AUTHORIZED=true` only after the source access permission and request policy are confirmed.
5. Start with `POST /v1/crawl/start` on the worker project.
6. Inspect `GET /api/crawl/status` on the core API with the admin bearer token.

The worker processes a small sequential batch per durable step. The full inventory may take hours, depending on source response time and retry-after responses. It is not a one-request export.

## Retention limitation

`crikora_cache` remains a rolling 600-second cache. Earlier page payloads expire while a multi-hour crawl is still running. The persistent crawl queue is not an archive: it stores URLs and processing metadata only. A complete historical snapshot or provider comparison requiring all page payloads to coexist needs a separately approved archive/export retention policy. This implementation deliberately does not extend the ten-minute data-retention requirement.

## Independent cache cleanup

The repository includes `neon/functions/cache-cleanup`. The function is dependency-free and forwards the authenticated scheduled invocation to the core API's `/api/cleanup` endpoint. Deploy it with environment variables `CRIKORA_API_BASE_URL=https://crikora.vercel.app/api` and `CRIKORA_REFRESH_SECRET` set to the same sensitive value as the core API, then create the Neon Function Trigger with schedule `* * * * *` (once per minute). Neon schedule triggers run outside the Postgres compute and are compatible with scale-to-zero.
