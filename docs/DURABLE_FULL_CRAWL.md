# Durable Crikora scraper

## What is now implemented

- The saved sitemap inventory is merged with the current sitemap where available, then filtered to cricket-data routes only: matches, facts, scorecards, squads, players, teams, series, venues, news, videos, galleries and cricket statistics. Homepage, advertising, careers, account, login and unrelated site pages are not queued.
- Each URL is stored as queue metadata in Neon. URL jobs use leases and can be reclaimed after a worker restart.
- The crawler parses a page through the existing Cricbuzz provider, stores its normalized entity in `crikora_cache`, and follows further allowlisted links.
- Match overview, facts, squads and scorecard URLs have distinct classification. The allowlist explicitly accepts match facts and squad paths.
- A page returning HTTP 401/403, 404 or another non-throttle 4xx, a redirect, or an access-challenge document is marked skipped individually. The run continues with other cricket pages. HTTP 429 honors `Retry-After`; transient 5xx/network failures use bounded retries. A challenge on one sitemap document is skipped while the remaining sitemap documents and saved inventory are still used.
- At protected full-crawl start, the API reads the current public `/sitemap.xml`, follows available cricket sitemap documents, and merges the resulting page URLs with the saved inventory snapshot. Sitemap XML is discovery metadata, not a cricket entity. Sitemap membership does not make homepage, advertising, careers, account or other non-cricket site pages eligible for collection.
- A sitemap refresh adds newly discovered URLs to an already queued/running or paused crawl run; existing queue uniqueness prevents duplicate jobs.
- The durable queue also stores a stable identity key derived from the Cricbuzz entity type and source ID. Alternate slugs for the same match, player, team, series or content item are deduplicated, while match facts, scorecards and squads remain separate page types. Current sitemap URLs take precedence over saved-snapshot aliases.
- The worker drains the full-crawl queue before returning to normal live/upcoming/recent refreshes.
- The live refresh process also forwards unprocessed related links into the persistent queue.
- Scraped payloads use classified retention: volatile live scores, live commentary/graphs, player statistics, rankings and other live-analysis pages expire after 600 seconds. Stable fixtures, completed match records, player profiles, teams, series, venues, news, videos and galleries remain available until the same source identity is refreshed. Stable rows are upserted in place; this is not a versioned archive. The queue keeps only URL, progress, lease and error metadata.

## Database migrations

Apply migrations `001` through `006` to the production Neon branch in order. Migration `004_crikora_durable_crawl.sql` creates the run and URL queue tables. Migration `005_crawl_queue_identity_keys.sql` adds a stable page-identity key and marks already-queued same-identity aliases as skipped. Migration `006_classified_cache_retention.sql` makes cache expiry nullable and adds the retention class; it preserves existing payload rows and converts stable records to non-expiring entries.

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
- `CRIKORA_COLLECTION_ENABLED=true` when the operator is ready to enable the scraper. This is Crikora's own feature switch, not a Cricbuzz API key or a source-side allowlist.

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

1. Confirm migrations 001-005 are applied to Neon production.
2. Configure the required core and worker environment variables in their respective hosting projects.
3. Keep the crawler setting disabled until the selected API and worker can reach the same Neon production branch and health checks pass.
4. Set `CRIKORA_COLLECTION_ENABLED=true` to enable the protected scraper API. This internal switch does not require Cricbuzz-issued API credentials.
5. Start with `POST /v1/crawl/start` on the worker project.
6. Inspect `GET /api/crawl/status` on the core API with the admin bearer token.

The worker processes a small sequential batch per durable step. The full inventory may take hours, depending on source response time and retry-after responses. It is not a one-request export.

## Classified cache retention

`crikora_cache` is no longer a global 600-second cache. Volatile data (live match scores, live commentary/graphs, player statistics, rankings, match scorecards and other live-analysis pages) expires after 600 seconds and is refreshed on subsequent ingestion cycles. Stable data (upcoming fixtures, completed match records, player profiles, teams, series, venues, news, videos and galleries) has no time-based expiry and remains available until the same source identity is refreshed by a later crawl. A live match can therefore expire while it is live, then be retained after a later refresh identifies it as completed. Stable rows are updated in place using the existing (entity_type, source_id) key; previous versions are not retained. The durable crawl queue is not an archive: it stores URLs and processing metadata only. Payloads that were deleted under the former global TTL cannot be reconstructed from the queue; the crawler must fetch those pages again. A versioned historical snapshot still requires a separately approved archive/export design.
## Independent cache cleanup

The repository includes `neon/functions/cache-cleanup`. The function is dependency-free and forwards the authenticated scheduled invocation to the core API's `/api/cleanup` endpoint. Deploy it with environment variables `CRIKORA_API_BASE_URL=https://crikora.vercel.app/api` and `CRIKORA_REFRESH_SECRET` set to the same sensitive value as the core API, then create the Neon Function Trigger with schedule `* * * * *` (once per minute). Neon schedule triggers run outside the Postgres compute and are compatible with scale-to-zero.

## Standalone worker alternative

If Vercel project creation for the separate worker is unavailable, the repository includes `npm run worker:local`. It runs the same scheduler from a persistent Node.js process and uses the shared Neon worker lease. Add `CRIKORA_API_BASE_URL`, `DATABASE_URL`, `CRIKORA_ADMIN_SECRET` and `CRIKORA_REFRESH_SECRET` to the root `.env` file.

Run `npm run worker:local` to drain an existing crawl and then perform normal refreshes. Run `npm run worker:local -- --start-crawl` to seed/resume the full sitemap crawl before draining it. Set the internal `CRIKORA_COLLECTION_ENABLED` switch only on the selected production API runtime. It is not a third-party credential.