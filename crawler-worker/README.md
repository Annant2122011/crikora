# Crikora durable crawler worker

This is the Vercel-hosted scheduler for the Crikora Cricbuzz HTML collector. It uses Vercel Workflow (Nitro integration) for durable sleeps and resumes. It does **not** keep a Node timer alive inside a request-driven Function.

## Architecture

- The worker runs a durable loop and sleeps for the configured 10, 15, 20 or 30 seconds.
- The loop reads persistent settings from the core Crikora API before each cycle.
- When a durable sitemap crawl is active, it calls authenticated `POST /crawl/step` and drains the Neon-backed URL queue in small, bounded batches.
- After the initial queue completes, it calls authenticated `POST /refresh` on the configured cadence for live/upcoming/recent match monitoring.
- URL/job metadata is durable in Neon; scraped entity payloads are written to `crikora_cache` and retain the normal ten-minute TTL.
- Neon holds a singleton lease so concurrent start requests cannot create overlapping durable loops.
- The refresh API serializes scraper cycles using `crikora_crawler_settings`.
- A 429 response is delayed using `Retry-After`; 401/403 stops the loop; a hard source denial disables the collector through the core API.

## Vercel project setup

Create a separate Vercel project connected to `Annant2122011/crikora` with:

- Project name: `crikora-crawler`
- Root Directory: `crawler-worker`
- Framework: Nitro
- Install command: `npm install`
- Build command: `npm run build`

The repository connection is prepared. Project creation must be completed by a Vercel team member with project-create permission because the connected Vercel API returned HTTP 403 for this account.

## Required server-side environment variables

Set these only in the Vercel project. Never expose them in a browser extension:

- `CRIKORA_API_BASE_URL`: the deployed core API base ending in `/api`
- `DATABASE_URL`: Neon pooled connection string for the Crikora database
- `CRIKORA_REFRESH_SECRET`: the same secret configured on the core API
- `CRIKORA_ADMIN_SECRET`: the same secret configured on the core API
- `CRIKORA_WORKER_ADMIN_SECRET`: a separate random secret used to manage the workflow

Run migration `migrations/003_crikora_worker_state.sql` once against the Crikora Neon database before starting the worker.

## Operations

All management endpoints require `Authorization: Bearer <CRIKORA_WORKER_ADMIN_SECRET>`.

- `POST /v1/crawl/start` seeds/resumes the complete allowlisted sitemap crawl and starts the durable workflow.
- `GET /health`
- `GET /v1/settings`
- `PUT /v1/settings` with `{"refreshIntervalSeconds":10}`, `15`, `20` or `30`
- `PUT /v1/settings` with `{"enabled":true}` to enable and start the workflow
- `PUT /v1/settings` with `{"enabled":false}` to stop after the current cycle
- `POST /v1/loop/start`
- `POST /v1/loop/stop`

The default persistent cadence is 10 seconds. The interval is measured from the start of one refresh cycle; if a cycle takes longer than the configured period, the next cycle starts as soon as the refresh lock permits. Source-side 429 responses are always honored.

## Important

The worker only schedules requests to the existing public-HTML collector and the durable URL queue. Apply migration `004_crikora_durable_crawl.sql` before using `POST /v1/crawl/start`. It does not call undocumented app endpoints, reverse-engineer private media APIs, download stream segments, bypass access challenges or evade source denials.
