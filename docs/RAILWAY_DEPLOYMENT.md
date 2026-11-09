# Railway deployment for Crikora

Railway runs the same TypeScript API handler and durable Neon-backed crawl queue as the Vercel adapter. It does not create a second database: Neon PostgreSQL remains the production source of truth.

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
- `CRICBUZZ_AUTOMATION_AUTHORIZED=false` until the source authorization and operational start are explicitly approved
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

Do not place any of these values in browser code, a public repository, logs or screenshots.

## Safe first deployment

1. Deploy the API and worker with `CRICBUZZ_AUTOMATION_AUTHORIZED=false`. The worker idles and makes no Cricbuzz requests.
2. Verify `GET /api/health` reports PostgreSQL reachable, automation disabled, and 600-second retention.
3. Verify the worker logs show its disabled/idle state and that the Neon crawl queue remains empty.
4. Only after the source permission and request policy have been explicitly approved for production operation, set the API variable `CRICBUZZ_AUTOMATION_AUTHORIZED=true` and use the authenticated settings endpoint to enable the crawler. With `CRIKORA_START_FULL_CRAWL=true`, the worker seeds the current sitemap plus saved inventory and drains the durable queue in sequential bounded batches.

To enable via an authenticated server-side request after deployment:

```sh
curl -X PUT "https://<api-service-domain>/api/settings" \
  -H "Authorization: Bearer <CRIKORA_ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"refreshIntervalSeconds":10}'
```

Never expose the admin secret to the browser. The 10, 15, 20 and 30-second refresh choices are persisted in Neon. Source pacing is separate from refresh cadence; HTTP 401/403, redirects and 429 responses continue to stop or pause collection rather than being bypassed.

## Data completeness and retention

The collector extracts structured fields, links, tables, JSON-LD, visible text and image/media URLs from the public HTML pages it can fetch. It is not a headless browser and does not execute client-side JavaScript. Data records expire after 600 seconds. The durable queue persists URL and job metadata, not historical page payloads. A complete permanent archive or guaranteed capture of dynamically hydrated/private data is outside this live-cache scraper's current contract.

## Build validation

Run `npm run typecheck`, `npm run test` and `npm run build:railway`. Railway builds both the API handler and worker entrypoint into `dist-railway/`.
