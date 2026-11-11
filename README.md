# Crikora

Crikora is a cricket data collector and JSON API for the Crikora browser extension and website.

## Prototype collection scope

Crikora's production collection is deliberately limited to four Cricbuzz data families. The old 4,721-URL sitemap audit remains in `docs/cricbuzz-sitemap-inventory.json` as a reference and fallback source for just the player-profile and news-article routes; it is **not** merged into the normal crawl queue.

| Data family | Collection scope |
| --- | --- |
| Match centre | Match overviews, facts, scorecards, squads, innings, extras, partnerships, fall of wickets, commentary and structured deliveries from **4 November 2026 onward** |
| Player profiles | All profiles exposed by Cricbuzz's player sitemap, plus players discovered from match squads, fixtures and news; all source-labelled profile fields, biography, images, RSC data and career-stat tabs. If a Cricbuzz photo is missing, a narrow ESPNcricinfo player-directory lookup adds its profile URL, image and complete returned player payload. |
| Schedule | Upcoming schedule indexes and series-linked fixtures, date/time, teams, format, competition and venue where Cricbuzz exposes them; historical series catalogs are excluded |
| News | Every article exposed by Cricbuzz's cricket-news sitemap, with full available article text, title, author, category, timestamps, image URL, tags and source metadata |

Both men's and women's cricket are included in every collection family. The cutoff is a date filter for match detail collection, not a gender or tournament filter. Older ball-by-ball matches are intentionally excluded from Cricbuzz collection because they will be supplied separately from Cricsheet.

The saved sitemap audit contained 303 player-profile routes (302 profile pages plus one stats tab) and 770 news-article URLs. Those are the saved fallback inventory counts, not a promise that Cricbuzz's live sitemaps contain exactly those totals today. The normal crawler fetches only the two relevant sitemaps, the three match indexes and three focused section indexes (overall upcoming schedule, international upcoming schedule, and latest news). It does not traverse the root sitemap, team directory, scorecard archive, videos, photo galleries, rankings, historical matches before the cutoff or unrelated site routes.

See [the source coverage audit](./docs/STAGE_1_SOURCE_COVERAGE_AUDIT.md) for how the saved inventory was assembled. A captured HTML page is source evidence, not proof that every field Cricbuzz may return through interactive client-side tabs is available in static HTML.

## What the collector reads

The backend discovers **both men's and women's** matches from Cricbuzz's live, upcoming and recent indexes. Match details are collected from 4 November 2026 onward; older ball-by-ball history is reserved for the separate Cricsheet import. The format classifier keeps Test, ODI, T20, T10, Sixes and The Hundred distinct. Match facts, scorecards, squads, innings, commentary and participant profiles are enriched through a small durable queue. The normal refresh path only polls match indexes; slow-changing profile, schedule and news pages are handled by their own bounded crawl queue. It follows public same-host links and does not guess private Cricbuzz APIs:

- Match page: live score summary, match identity, competition, teams, format, result and match navigation.
- Info/facts: date/time text, venue, toss, officials, match facts and related venue/series links.
- Scorecard: innings totals, batting and bowling rows, extras breakdown, partnerships, fall of wickets and delivery-by-delivery records when the structured source data exposes them. The normalized `matchData` object keeps source fields and extraction-coverage signals.
- Squads: playing XI, bench/support-staff headings, player links and team images.
- Full commentary: structured delivery IDs, innings/over/ball coordinates, striker/non-striker/bowler, bat runs, extras, total runs, dismissal/fielder fields, event descriptions and commentary. The old parent-div wall-of-text heuristic has been removed.
- Player profiles: profile images, every source-labelled detail field, biography sections, teams, debut/role/style/date/height, career-stat tables, JSON-LD and decoded React Server Component flight data. Common attributes are normalized; additional source fields remain in the typed attribute table and immutable original HTML evidence. The player-detail endpoint also returns linked batting/bowling/all-matches tabs where exposed.
- Schedule and series pages: fixtures, participant teams, competition, format, India-local start time and venue are normalized into a dedicated schedule read model. Linked match pages are fed into the match-detail collector.

- News articles: full available article text, title, summary, byline, published/modified timestamps, category, image URL, tags and original page metadata are stored in a dedicated article projection. Source HTML and RSC scripts remain in the private archive for parser upgrades.

The prototype's distinctive client-facing sections are a rich player profile with source-labelled fields and career stats, a player comparison view, a match centre with the structured innings/commentary timeline, a full fixture calendar and a searchable article feed. Image assets remain external Cricbuzz-hosted HTTPS URLs; video streams are not downloaded. Collection does not bypass login, anti-bot checks or source access controls.

## JSON API

All successful data endpoints return JSON with a `data` field and small `meta` object. Index discovery makes the full visible match list available immediately; the detail fields for matches, players, teams, series and venues are progressively enriched over successive collection cycles. Every entity contains `id`, `entityType`, `sourceUrl`, `fetchedAt`, `retentionClass` and `expiresAt`. `ttlSeconds` is 600 for ephemeral records and `null` for persistent records. Response metadata describes the shared retention policy.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Vercel API, Neon and crawler readiness |
| `GET /api/settings` | Current refresh cadence and crawler status |
| `PUT /api/settings` | Set refresh cadence (10, 15, 20 or 30 seconds) and enable/disable collection; server-side admin token required |
| `POST /api/refresh` | Run one collection cycle; server-side refresh token required and cadence enforced in Neon |
| `GET /api/v1/matches` | Paginated match list with optional status, limit and offset |
| `GET /api/v1/matches/:matchId` | Match detail |
| `GET /api/v1/matches/:matchId/events` | Match event timeline |
| `GET /api/v1/players?limit=100&offset=0` | Paginated player directory; profiles contain all extracted source fields |
| `GET /api/v1/players/:id` | Full player profile |
| `GET /api/v1/players/compare?ids=11527,10012` | Compare 2–4 players by source-labelled profile fields and career stats |
| `GET /api/v1/news?limit=100&offset=0` and `GET /api/v1/news/:id` | Full article feed and article detail |
| `GET /api/v1/schedule?limit=200&offset=0` | Paginated normalized fixture schedule |
| `GET /api/v1/teams`, `/series`, `/venues` | Supporting entities used by match and profile pages |
| `GET /api/v1/search?q=india` | Search cached JSON payloads |


Match IDs in the API can be passed with or without the `cricbuzz:` prefix. Use the numeric Cricbuzz source ID for player/team/series/venue entity routes.

## Browser extension and website integration

The shared browser-safe API client lives at `src/client/crikora-api-client.ts`. Import it from the extension or website bundle and point it at the deployed Crikora API origin:

```ts
import { CrikoraApiClient } from "./client/crikora-api-client.js";

const crikora = new CrikoraApiClient("https://crikora.vercel.app/api");
const { data: liveMatches } = await crikora.listLiveMatches();
const { data: match } = await crikora.getMatch(liveMatches[0]!.id);
const { data: players } = await crikora.listPlayers();

// Refresh is a protected server-to-server POST, not a browser request.
// The API's CRIKORA_REFRESH_SECRET must never be bundled into the extension.
```

The client exposes typed methods for live/upcoming/recent matches, paginated player profiles, 2–4-player comparison, news articles, fixtures, match details and events, supporting entities, entity lookup, search and health checks. It uses JSON-only GET requests, disables browser HTTP caching, supports `AbortSignal`, URL-encodes IDs and surfaces structured HTTP errors. The browser must call the Crikora API, never Cricbuzz directly. Keep `DATABASE_URL` and Crikora's own admin/refresh secrets on the backend only. The public-HTML scraper does not need Cricbuzz-issued API credentials.



### Production API and fallback

**Primary API base (Vercel):**

`https://crikora.vercel.app/api`

Vercel remains the preferred primary host. Railway is the maintained backup API and worker, using the same Neon database and the same source branch. Because the current Vercel account has been blocked by its build-rate limit, the API base can be switched to Railway without changing client data contracts.

**Railway fallback API base:**

`https://crikora-api-production.up.railway.app/api`

During fallback, point the website and extension at the Railway API URL. Only one worker should own collection at a time. Both runtimes share the Neon worker lease; keep the unused worker disabled/standby and do not deploy two independent crawlers against Cricbuzz.

Public read routes include:

- `GET /health`
- `GET /v1/matches?status=live|upcoming|completed&limit=100`
- `GET /v1/matches/:matchId`
- `GET /v1/matches/:matchId/events`
- `GET /v1/players?limit=100&offset=0` and `GET /v1/players/:id`
- `GET /v1/players/compare?ids=11527,10012` (compare 2–4 players by available source-labelled fields)
- `GET /v1/teams?limit=100` and `GET /v1/teams/:id`
- `GET /v1/series?limit=100` and `GET /v1/series/:id`
- `GET /v1/venues?limit=100` and `GET /v1/venues/:id`
- `GET /v1/news?limit=100&offset=0` and `GET /v1/news/:id`
- `GET /v1/schedule?limit=200&offset=0`
- `GET /v1/content?kind=news|video|gallery&limit=100` remains available for supplemental metadata only
- `GET /v1/search?q=india&limit=30`
- `GET /v1/archive/coverage`
- `GET /v1/archive/entities/:entityType?limit=50&before=<cursor>`
- `GET /v1/archive/entities/:entityType/:sourceId/history?limit=50&before=<cursor>`
- `GET /v1/entities/:entityType/:sourceId/details?limit=100` returns the latest entity plus its archived, linked subpages (for example a player's batting/bowling tabs).

The API returns JSON envelopes with `data` and `meta`; timestamps, `retentionClass`, nullable `expiresAt` and a per-record `ttlSeconds` travel with stored entities. Browser code must use public GET routes only. Keep `DATABASE_URL`, `CRIKORA_ADMIN_SECRET` and `CRIKORA_REFRESH_SECRET` server-side. Refresh and crawl control routes are protected and must never be called from the browser.

## Classified cache retention

The cache applies a ten-minute lifetime only to volatile records: live match scores, player-stat subpages, rankings, live commentary, live graphs, over-by-over data, forecasts and other live-analysis pages. These records are refreshed by later collection cycles and are removed after 600 seconds without a refresh.

Stable records are retained in the serving cache until their source identity is refreshed. The cache remains an up-to-date read model, not the historical record. Each distinct normalized entity version is also inserted into the permanent append-only `crikora_entity_snapshots` table. Raw Cricbuzz HTML is gzip-compressed in `crikora_source_page_snapshots`: low-churn pages are saved on each content change, while high-churn match/live-analysis pages are sampled at most once per hour per URL. Every normalized score, delivery/event, profile and statistics change continues to be versioned independently. Both snapshot tables reject UPDATE and DELETE operations. The URL-level `crikora_archive_coverage` ledger records discovery and capture outcomes independently of cache expiry.

PostgreSQL cleanup still deletes only expired cache rows. It never touches the permanent snapshot tables. If source content changes A → B → A, all three observations are retained; identical consecutive refreshes are deduplicated. This is permanent application-level retention, not a replacement for independent Neon backups and exports.

## Permanent historical archive

The permanent archive is an evidence-backed history layer separate from the current cache. It stores only the selected product families: matches from 4 November 2026 onward, player profiles and their statistics tabs, schedule/series fixture pages, and all articles exposed by the news sitemap. The prior broad sitemap queue is paused and retained as an audit record; it is not processed by the new worker. Earlier ball-by-ball matches are left to the Cricsheet import.

- `crikora_entity_snapshots` stores every observed distinct normalized entity version. A later return to an earlier payload is stored as a new observation.
- `crikora_source_page_snapshots` stores source URL, page kind, SHA-256, original/compressed byte counts and an object key. The compressed HTML (including embedded React flight scripts) is stored in the private Neon Object Storage bucket `crikora-raw-archive`, not in PostgreSQL. Existing legacy `body_gzip` rows remain readable during migration. Low-churn pages are captured whenever content changes; high-churn match/live-analysis/index URLs are captured at most once per hour per URL. This does not throttle normalized entity snapshots.
- `crikora_archive_coverage` records discovered, pending, processing, captured, skipped and failed URLs by route family.
- `GET /v1/archive/coverage` reports the current archive coverage ledger.
- `GET /v1/archive/entities/:entityType` lists each entity's latest archived version with cursor pagination.
- `GET /v1/archive/entities/:entityType/:sourceId/history` lists immutable versions of one entity.

Use `CrikoraApiClient.getArchiveCoverage()`, `listArchivedEntities()` and `getEntityHistory()` from the website or extension. Browser clients receive normalized JSON only. They never receive database credentials or raw HTML storage access.

The targeted crawl continuously refreshes match indexes, enriches eligible match pages from the configured start date, refreshes stable player profiles and career tabs daily, schedule/news indexes every 30 minutes and article details daily. The queue is DB-backed in Neon and is independent of the Railway/Vercel process lifetime. A coverage status of "captured" means a public page was fetched and archived, not that Cricbuzz exposed every possible field in that page. Check skipped/failed counts and profile field coverage before treating a page family as complete.

## Backend-only Neon archive storage environment

The API uses these five variables to write compressed source HTML to the private Neon Object Storage bucket. They must be configured on the **core API runtime** (the repository-root Vercel API project or Railway's `crikora-api` service), not on the browser extension, website or crawler worker:

```dotenv
AWS_ENDPOINT_URL_S3=https://br-cold-bird-bdw51znf.storage.c-8.us-east-2.aws.neon.tech
AWS_REGION=us-east-2
AWS_ACCESS_KEY_ID=<NEON_STORAGE_TOKEN_ID>
AWS_SECRET_ACCESS_KEY=<NEON_STORAGE_S3_SECRET_ACCESS_KEY>
CRIKORA_ARCHIVE_BUCKET=crikora-raw-archive
```

Use the branch-scoped Neon Object Storage credential created for the `production` branch. `AWS_ACCESS_KEY_ID` is its `token_id`; `AWS_SECRET_ACCESS_KEY` is its `s3_secret_access_key`. Do not substitute the Neon API token. For local development, place the values in an untracked `.env` file. For Vercel, add them as encrypted/sensitive **Production** variables on the root API project. For Railway, add them to the `crikora-api` service in the `production` environment. The separate crawler worker only calls the API and does not need the S3 secret. The frontend and browser extension must never receive any of these five variables.

The server imports `dotenv/config`, validates the five names, and calls `createArchiveObjectStoreFromEnv(process.env)` before constructing `PostgresEntityRepository`. If the variables are all absent in development, the legacy local bytea fallback is used; a partial set fails at startup; production requires all five. `GET /health` exposes only `archiveObjectStorage: "configured"` or the local fallback state, never secret values. This configuration flag is not a live upload/download test. After adding the five values to a local `.env` or the core API host, run `npm run archive:verify-storage` from the repository root. It uploads a tiny uniquely named diagnostic object to `diagnostics/roundtrip/`, downloads it again and checks the bytes and SHA-256. Keep the worker disabled until this command succeeds. Each successful diagnostic run leaves one small object in the private bucket.

## Neon setup

A separate Neon project named `crikora` was created for cricket data. The existing `resolvX` support-bot database was left untouched.

1. Apply migrations `001_crikora_cache.sql` through `011_targeted_news_schedule_and_crawl_scope.sql` to the Crikora production database, in numeric order. Migrations 007-010 add archive evidence and typed player/match projections; migration 011 adds the targeted run scope and dedicated news/schedule read models.
2. Set the **pooled** Neon connection string in the backend environment as `DATABASE_URL`. Do not put it in the browser extension or commit it.
3. Keep `CRIKORA_COLLECTION_ENABLED=false` until the selected runtime and worker have passed their health checks. This is Crikora’s own operator-controlled feature switch, not a Cricbuzz-issued credential or source-side allowlist.
4. Set `CRIKORA_ADMIN_SECRET` and `CRIKORA_REFRESH_SECRET` as Vercel server-only secrets. Set `CORS_ORIGINS` to exact deployed origins when browser calls are introduced.

The production API requires `DATABASE_URL` and uses Neon PostgreSQL as its only production store. The demo source-mode switch has been removed.

## Run locally

Requirements: Node.js 20+.

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

## Refresh cadence and settings

The default refresh interval is **10 seconds**, the fastest supported option. The user can select 10, 15, 20 or 30 seconds. The selected interval is persisted in `public.crikora_crawler_settings` and enforced by the API before a refresh can start.

- `GET /api/settings` returns the current interval and enable state.
- `PUT /api/settings` updates `refreshIntervalSeconds` and/or `enabled`. It requires `Authorization: Bearer <CRIKORA_ADMIN_SECRET>`.
- `POST /api/refresh` executes one collection cycle. It requires `Authorization: Bearer <CRIKORA_REFRESH_SECRET>`.
- The refresh endpoint has a database-backed lease and minimum-interval gate, so concurrent Vercel instances cannot overlap collection cycles. The separate `crawler-worker/` Nitro project starts a durable Vercel Workflow that sleeps and resumes at the persisted cadence; it is not an in-memory timer inside a Function.
- The Vercel durable worker owns the production 10/15/20/30-second schedule. The future extension should read the JSON API using `CrikoraApiClient`; it must not run a second scraper or call Cricbuzz directly. `src/client/refresh-controller.ts` remains available for an explicitly client-driven/local refresh workflow, not as the production Vercel scheduler.

Refresh cadence and source-request pacing are separate. `POLL_INTERVAL_SECONDS` controls the local long-running server. On Vercel, the durable worker reads `refresh_interval_seconds` from Neon. `CRICBUZZ_MIN_REQUEST_INTERVAL_MS` controls spacing between individual source requests. A page-level 401/403/404, redirect or access challenge marks only that URL as skipped; it does not stop the whole crawl. HTTP 429 honours `Retry-After`, while transient 5xx/network failures retry with bounded backoff.

**Vercel hosting note:** deploy the core API from the repository root and the durable scheduler as a separate Vercel project with root directory `crawler-worker`. A durable Vercel Workflow handles the 10/15/20/30-second schedule; a minute-based Cron job is not used as a substitute for a ten-second scheduler. The Vercel management connector currently returns no project records, so project settings and encrypted environment values cannot be edited through that connector. However, GitHub confirms the existing `Vercel – crikora` and `Vercel – crikora-crawler` deployment checks are attached to this repository. Both currently report the account build-rate limit; GitHub Actions independently builds and tests the root API and the separate Nitro worker. See [`crawler-worker/README.md`](./crawler-worker/README.md).

## Technical safety and known limits

- All page requests are sequential, same-host HTTPS, timeout bounded, and response-size bounded.
- Individual page 401/403/404 responses, redirects and CAPTCHA/anti-bot challenge pages are recorded as skipped URLs. 429 honours `Retry-After`; transient 5xx/network failures use bounded backoff. The scraper does not attempt to evade a challenge.
- Links are host-checked and constrained to known Cricbuzz match, profile, team, series, news, video, gallery, statistics, schedule, commentary and special-content route families.
- Images are exposed as external URLs. They are not copied to Crikora object storage.
- HTML schemas can change. Keep representative fixtures and re-run the parser tests when Cricbuzz changes markup.
- This is a static-HTML collector, not a full browser automation engine. It does not execute Cricbuzz client-side JavaScript, trigger interactive tabs, or retrieve data that only appears after browser-side hydration. Some profile tabs, charts, or statistics may therefore be absent. The collector archives the complete fetched HTML, including embedded React Server Component flight scripts, and exposes decoded keyed page data beside normalized tables, labels and sections. This preserves source evidence for later parser upgrades, but it still cannot capture data that Cricbuzz only returns after client-side interactions or from inaccessible/authenticated app services. It does not fabricate missing values.
- Volatile feed data expires after ten minutes; stable records remain until refreshed. This is not a versioned historical score archive.

## CI

GitHub Actions runs typecheck, build and tests on pushes and pull requests to `main`.

## Targeted durable collection

The initial product crawl fetches only the player-profile and cricket-news sitemaps, the live/upcoming/recent match indexes, and the selected schedule indexes. It never merges the root sitemap or the full 4,721-URL audit into the queue. The durable Neon queue uses leases and bounded retries. The worker calls the lightweight `POST /api/refresh/index` route between crawl batches so live/upcoming/recent match summaries stay current.

- Core API: `POST /api/crawl/start`, `GET /api/crawl/status`, `POST /api/crawl/step`, `POST /api/cleanup`.
- Worker: `POST /v1/crawl/start` (requires the worker admin bearer token).
- Volatile serving-cache payloads expire after 600 seconds. Migration 007 stores permanent normalized entity versions and gzip-compressed raw HTML in private Neon Object Storage, with indexed hashes, keys, sizes and coverage metadata in PostgreSQL. Queue metadata remains durable in Neon.
- The collector reads static HTML from the cricket-data routes in its allowlist. It ignores homepage, advertising, careers, account/login and unrelated site pages. It does not execute browser JavaScript, access private services, bypass CAPTCHA or source denials, or download video streams.

See [the durable crawl runbook](./docs/DURABLE_FULL_CRAWL.md) for the complete route and deployment setup.

## Standalone worker

The core API can be paired with a persistent Node.js worker without creating another Vercel project. This runner belongs to this repository and uses the Neon worker lease to prevent two schedulers from running at once.

```bash
npm ci
npm run worker:local
```

To seed or resume the targeted matches/players/schedule/news collection and drain its durable queue:

```bash
npm run worker:local -- --start-crawl
```

`worker:local -- --once` performs one scheduler pass and exits. The standalone worker reads the enabled flag and refresh cadence from the API/Neon, follows API `Retry-After` responses, refreshes its Neon lease while sleeping, and stops cleanly on Ctrl+C. It does not start source collection while crawler settings are disabled.

The machine running this process must stay online for continuous scraping. It requires `DATABASE_URL`, `CRIKORA_API_BASE_URL`, `CRIKORA_ADMIN_SECRET` and `CRIKORA_REFRESH_SECRET` in the local server-only `.env` file. Never put these values in the browser extension or commit `.env`.