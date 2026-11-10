# Railway fallback deployment for Crikora

Vercel is the primary production runtime. Railway is a prepared fallback used only when Vercel cannot build or deploy (for example, a Hobby build-rate limit). Both runtimes share the same Neon PostgreSQL database and code; do not run both schedulers at once. The Vercel durable workflow owns the singleton Neon worker lease while primary. The Railway worker is configured as standby and must be explicitly enabled only during a fallback.

## Services

Create two services from this repository's `main` branch, with the repository root as the build root:

| Setting | API service | Worker service |
| --- | --- | --- |
| Build command | `npm run build:railway` | `npm run build:railway` |
| Start command | `npm run start:railway-api` | `npm run start:railway-worker` |
| Health check | `/api/health` | Not applicable |
| Runtime | Node.js 20+ | Node.js 20+ |

The API adapter forwards native Node HTTP requests to the shared `api/[...path].ts` handler. It therefore exposes the same data, settings, refresh, sitemap crawl and cache-cleanup routes without maintaining a second implementation.

The worker takes a Neon singleton lease and calls the API's protected control routes. When the crawler is disabled it stays online, renews its lease, checks settings periodically, and makes no source requests. When enabled, it can seed the initial sitemap crawl automatically if `CRIKORA_START_FULL_CRAWL=true`.

## API service variables

Set these server-side in Railway:

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `DATABASE_URL`: Neon pooled connection string for the Crikora production branch
- `CRIKORA_ADMIN_SECRET`: private random bearer secret
- `CRIKORA_REFRESH_SECRET`: private random bearer secret shared with the worker
- `CRIKORA_COLLECTION_ENABLED=false` until the operator enables the chosen API runtime
- `CRICBUZZ_MIN_REQUEST_INTERVAL_MS=1000`
- `CRIKORA_CRAWL_BATCH_SIZE=2`
- `CRIKORA_CRAWL_MAX_ATTEMPTS=4`
- `CORS_ORIGINS=https://crikora.vercel.app` (add other exact website/extension origins only when known)

The API's public health route is `GET /api/health`; data routes include `/api/v1/matches`, `/api/v1/players`, `/api/v1/teams`, `/api/v1/series`, `/api/v1/venues`, `/api/v1/content` and `/api/v1/search`.

## Worker service variables

- `NODE_ENV=production`
- `DATABASE_URL`: the same Neon production connection string
- `CRIKORA_API_BASE_URL=https://<api-service-domain>/api`
- `CRIKORA_ADMIN_SECRET`: exactly the API service's value
- `CRIKORA_REFRESH_SECRET`: exactly the API service's value
- `CRIKORA_WORKER_LEASE_SECONDS=180`
- `CRIKORA_WORKER_IDLE_POLL_SECONDS=10`
- `CRIKORA_START_FULL_CRAWL=true`
- `CRIKORA_WORKER_ENABLED=false` while Vercel is primary; set to `true` only during a Railway fallback

Do not place any of these values in browser code, a public repository, logs or screenshots.

## Safe first deployment

1. Keep Railway deployed but set `CRIKORA_WORKER_ENABLED=false`; the worker waits in standby without acquiring the Neon singleton lease. Keep `CRIKORA_COLLECTION_ENABLED=false` until the Railway API is selected for a fallback.
2. Verify `GET /api/health` reports PostgreSQL reachable, automation disabled, and 600-second retention.
3. Verify the worker logs show its disabled/idle state and that the Neon crawl queue remains empty.
4. During a Vercel build-rate-limit fallback, first disable/stop the Vercel workflow and let it release the Neon worker lease. Then set Railway API `CRIKORA_COLLECTION_ENABLED=true`, set Railway worker `CRIKORA_WORKER_ENABLED=true`, and enable the existing Neon crawler setting. The Railway worker resumes the existing durable queue rather than creating a duplicate run.

To enable via an authenticated server-side request after deployment:

```sh
curl -X PUT "https://<api-service-domain>/api/settings" \
  -H "Authorization: Bearer <CRIKORA_ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"refreshIntervalSeconds":10}'
```

Never expose the admin secret to the browser. The 10, 15, 20 and 30-second refresh choices are persisted in Neon. Source pacing is separate from refresh cadence. A denied or irrelevant cricket page is skipped; 429 honors `Retry-After`; transient 5xx/network failures retry. No challenge is bypassed.

## Data completeness and retention

The collector extracts structured fields, links, tables, JSON-LD, visible text and image/media URLs from the public HTML pages it can fetch. It is not a headless browser and does not execute client-side JavaScript. Data records expire after 600 seconds. The durable queue persists URL and job metadata, not historical page payloads. A complete permanent archive or guaranteed capture of dynamically hydrated/private data is outside this live-cache scraper's current contract.

## Build validation

Run `npm run typecheck`, `npm run test` and `npm run build:railway`. Railway builds both the API handler and worker entrypoint into `dist-railway/`. Keep `CRIKORA_WORKER_ENABLED=false` except during a Vercel deployment fallback.
