# Crikora durable crawler worker

This is the Vercel-hosted scheduler for the Crikora Cricbuzz HTML collector. It uses Vercel Workflow (Nitro integration) for durable sleeps and resumes. It does **not** keep a Node timer alive inside a request-driven Function.

## Architecture

- Vercel is the **primary** core API and durable scheduler. The core API lives at the repository root; the Vercel Workflow scheduler is the separate `crawler-worker/` project.
- Railway hosts the same core API and worker adapters as the **backup**. Both engines use the same Neon PostgreSQL production database, schemas, queue and data contracts.
- The API owns source requests, parsing, normalized projections, cache writes and private Neon Object Storage. The worker only schedules API calls and maintains the singleton Neon worker lease.
- The workflow performs one bounded durable crawl step, then a lightweight `POST /refresh/index` call for live/upcoming/recent match indexes. It sleeps according to the configured 10, 15, 20 or 30-second cadence.
- No broad root-sitemap or full-site crawl is used. Collection is limited to match details from 4 November 2026 onward, player profiles and their statistics tabs, schedule/series fixtures, and cricket-news articles. Both men's and women's cricket are included.
- Earlier ball-by-ball matches are provided separately from Cricsheet and are not crawled from Cricbuzz.
- Match overview pages fetch same-match facts, scorecard, squads and commentary pages directly. Squad/player links feed player profile enrichment. Each profile may link only to that player's own statistics tabs. News indexes lead to articles but articles do not recurse through related story links.
- Neon stores durable queue state, current entities, normalized delivery/profile/news/schedule projections and append-only history. Private Object Storage holds gzip-compressed source HTML and embedded React flight data.
- The singleton worker lease prevents the Vercel scheduler and Railway standby worker from collecting simultaneously. Keep Railway's worker disabled while Vercel is primary.

## Vercel project setup

Connect the GitHub repository `Annant2122011/crikora` as a separate Vercel project:

- Project name: `crikora-crawler`
- Root Directory: `crawler-worker`
- Framework: Nitro
- Install command: `npm install`
- Build command: `npm run build`
- Production branch: `main`

The core API is a second Vercel project with repository root as its Root Directory. The repository's two GitHub Vercel checks (`Vercel – crikora` and `Vercel – crikora-crawler`) are already attached to this source. If the Vercel build-rate limit is active, pushes still update the source and GitHub Actions validates both project build paths; Vercel automatically builds the production branch once its limit clears.

## Required server-side environment variables

Set these only on the Vercel worker project:

- `CRIKORA_API_BASE_URL`: Vercel core API base ending in `/api`
- `DATABASE_URL`: Neon pooled connection string for Crikora production
- `CRIKORA_REFRESH_SECRET`: same secret as the core API
- `CRIKORA_ADMIN_SECRET`: same secret as the core API
- `CRIKORA_WORKER_ADMIN_SECRET`: separate random secret for worker management endpoints

The Vercel core API project additionally requires `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CRIKORA_ARCHIVE_BUCKET`, `CRIKORA_MATCH_DETAILS_FROM=2026-11-04`, `DATABASE_URL`, `CRIKORA_ADMIN_SECRET`, `CRIKORA_REFRESH_SECRET` and `CRIKORA_COLLECTION_ENABLED`. The five object-storage variables must never be added to the worker project, website or extension.

Run migration `003_crikora_worker_state.sql` once and migrations `004`–`011` for the durable crawl and typed data projections before starting the worker.

## Operations

All worker-management endpoints require `Authorization: Bearer <CRIKORA_WORKER_ADMIN_SECRET>`.

- `POST /v1/crawl/start` seeds/resumes the targeted product queue through the core API, then launches the durable workflow.
- `GET /health`
- `GET /v1/settings`
- `PUT /v1/settings` with `{"refreshIntervalSeconds":10}`, `15`, `20` or `30`
- `PUT /v1/settings` with `{"enabled":true}` to start the primary scheduler after the core API is configured.
- `PUT /v1/settings` with `{"enabled":false}` to stop after the current cycle.
- `POST /v1/loop/start` and `POST /v1/loop/stop`

The worker does not start automatically from a web page or extension. First validate core API health and Neon Object Storage, then enable the crawler and call `POST /v1/crawl/start`. Do not run the Vercel and Railway workers concurrently.


## Important

The worker only schedules requests to the existing public-HTML collector and the durable URL queue. Apply migration `004_crikora_durable_crawl.sql` before using `POST /v1/crawl/start`. It does not call undocumented app endpoints, reverse-engineer private media APIs, download stream segments, bypass access challenges or evade source denials.
