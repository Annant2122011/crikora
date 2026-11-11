# Railway fallback deployment for Crikora

Vercel is the primary production runtime. Railway is the prepared backup. Both build the same GitHub repository and use the same Neon production database, migrations, API contracts, and targeted collector. Do not run both schedulers at the same time.

## Services

The Railway project contains two services from `Annant2122011/crikora`, with the repository root as the build root:

| Setting | `crikora-api` | `crikora-worker` |
|---|---|---|
| Build command | `npm run build:railway` | `npm run build:railway` |
| Start command | `npm run start:railway-api` | `npm run start:railway-worker` |
| Health check | `/api/health` | Worker service logs / workflow lease |
| Runtime | Node.js | Node.js |

The API adapter forwards requests to the same shared `api/[...path].ts` handler used by Vercel. The worker schedules the same Neon-backed queue and calls the same protected core API routes.

## API service environment

Set these encrypted/server-only variables on Railway `crikora-api`:

- `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=8080`
- `DATABASE_URL`: pooled Neon connection string for Crikora production
- `CRIKORA_ADMIN_SECRET` and `CRIKORA_REFRESH_SECRET`
- `CRIKORA_COLLECTION_ENABLED=false` until failover is selected
- `CRIKORA_MATCH_DETAILS_FROM=2026-11-04`
- `AWS_ENDPOINT_URL_S3=https://br-cold-bird-bdw51znf.storage.c-8.us-east-2.aws.neon.tech`
- `AWS_REGION=us-east-2`
- `AWS_ACCESS_KEY_ID`: Neon storage credential's `token_id`
- `AWS_SECRET_ACCESS_KEY`: same credential's `s3_secret_access_key`
- `CRIKORA_ARCHIVE_BUCKET=crikora-raw-archive`

The five storage variables are required by the production repository and must also be set on the Vercel core API project. They are not required on either worker, and must never be copied to the website or browser extension.

For the first Railway deployment, set `CRIKORA_VERIFY_ARCHIVE_STORAGE_ON_START=true`. On API startup it writes a small diagnostic object, reads it back, and checks byte length and SHA-256. Confirm the log line `CRIKORA_ARCHIVE_STORAGE_VERIFIED`, then set the flag to `false` to avoid creating a diagnostic object on each restart. If the check fails, keep collection disabled.

Recommended source pacing is `CRICBUZZ_MIN_REQUEST_INTERVAL_MS=1000`. Keep `CRIKORA_CRAWL_BATCH_SIZE=1` or `2` and `CRIKORA_CRAWL_MAX_ATTEMPTS=4`. These are server-only settings.

## Worker service environment

- `NODE_ENV=production`
- `DATABASE_URL`: same Neon production database
- `CRIKORA_API_BASE_URL=https://crikora-api-production.up.railway.app/api`
- `CRIKORA_ADMIN_SECRET`: same as the API
- `CRIKORA_REFRESH_SECRET`: same as the API
- `CRIKORA_WORKER_ENABLED=false` while Vercel is primary
- `CRIKORA_START_FULL_CRAWL=false` until deliberate failover
- `CRIKORA_WORKER_LEASE_SECONDS=180`
- `CRIKORA_WORKER_IDLE_POLL_SECONDS=10`

The worker is intentionally configured in standby. It must not start a crawl or acquire the singleton worker lease while Vercel is primary.

## Vercel primary configuration

The repository's root is the Vercel core API project. `crawler-worker/` is the separate Nitro/Vercel Workflow project. They are already represented by the GitHub check contexts `Vercel – crikora` and `Vercel – crikora-crawler`; GitHub Actions separately verifies the root build and worker build. The connected Vercel management integration currently does not expose project records, so project environment variables and deployment status must be verified in the Vercel dashboard.

The Vercel core API needs the same five object-storage variables as Railway's API plus `CRIKORA_MATCH_DETAILS_FROM=2026-11-04`, `DATABASE_URL`, `CRIKORA_ADMIN_SECRET`, `CRIKORA_REFRESH_SECRET` and `CRIKORA_COLLECTION_ENABLED`.

The Vercel worker needs `CRIKORA_API_BASE_URL=https://crikora.vercel.app/api`, `DATABASE_URL`, `CRIKORA_ADMIN_SECRET`, `CRIKORA_REFRESH_SECRET` and a separate `CRIKORA_WORKER_ADMIN_SECRET`. Do not add the S3 credentials to the worker project.

## Failover and recovery

### Switch from Vercel to Railway

1. Disable the Vercel crawler via the worker management endpoint or stop its workflow. Wait for the Neon worker lease to be released.
2. Verify Railway API health and `archiveObjectStorage: "configured"`. The first Railway deployment must have emitted `CRIKORA_ARCHIVE_STORAGE_VERIFIED`.
3. Set Railway core API `CRIKORA_COLLECTION_ENABLED=true`.
4. Set Railway `CRIKORA_WORKER_ENABLED=true` and deliberately start the existing targeted run through `POST /v1/crawl/start`.
5. Confirm the run scope is `targeted-product`. The legacy broad full-sitemap run remains paused and its queue rows are preserved.

### Switch back to Vercel

1. Stop the Railway worker and wait for its Neon worker lease to be released.
2. Point website and extension API configuration back to `https://crikora.vercel.app/api`.
3. Enable the Vercel core API collection switch and start the Vercel durable worker.
4. Return Railway's worker to `CRIKORA_WORKER_ENABLED=false` and keep the API collection switch off.

## Data scope

The targeted collector only fetches:
- Matches from 4 November 2026 onward, with facts, scorecard, squads, innings, extras, partnerships, fall of wickets and commentary.
- Player profiles and their own available statistics tabs.
- The public full match schedule and series fixture pages.
- All news articles exposed by the cricket-news sitemap.

Both men's and women's cricket are included. Older ball-by-ball data is left to Cricsheet. The crawler does not visit the root sitemap, video/galleries, ranking directories, old scorecard archives or thousands of unrelated URL families.

## Validation

GitHub Actions validates the root TypeScript/API build, all tests, Railway build, and separate Nitro worker typecheck/build. Vercel deploy checks are currently blocked by the account's build-rate limit, not by the code validation. The linked Vercel projects will consume the merged `main` branch automatically when Vercel's build limit clears.
