# Crikora

Crikora is a cricket data collector and JSON API for the Crikora browser extension and website.

## Sitemap-backed content inventory

The saved sitemap snapshot contains **4,721 raw URLs** and the 9 November current sitemap map contains **4,393 raw URLs**. Those counts are discovery totals, not the crawl queue size: the scraper now filters the union to cricket-data routes only and excludes advertising, careers, account/login and unrelated site pages. Current sitemap URLs take precedence over saved aliases. The saved inventory is [`docs/cricbuzz-sitemap-inventory.json`](./docs/cricbuzz-sitemap-inventory.json) and remains a fallback when a current sitemap document is unavailable. This is URL discovery, not a guarantee that every dynamic field appears in static HTML. See [the Stage 1 source coverage audit](./docs/STAGE_1_SOURCE_COVERAGE_AUDIT.md).

| Route family | URLs in latest map |
| --- | ---: |
| Series, subpages and auctions | 1,379 |
| Team pages and tabs | 989 |
| News articles and categories | 776 |
| Videos, collections, categories and playlists | 584 |
| Player profiles | 304 |
| Match scorecards | 189 |
| Match overview pages | 179 |
| Match facts | 126 |
| Squads | 120 |
| Player match-performance pages | 12 |
| Galleries and photo-gallery index | 11 |
| Live-stream landing pages | 6 |
| Rankings/statistics | 5 |
| Match forecasts | 5 |
| Other match highlights, schedules, archives, commentary, graphs and special-content pages | Remaining mapped routes |

Representative public pages were fetched successfully, but a full HTML-body crawl of all mapped URLs was not completed. See [`docs/CRICBUZZ_HTML_AND_NON_HTML_COVERAGE.md`](./docs/CRICBUZZ_HTML_AND_NON_HTML_COVERAGE.md) for the route audit, tested page samples, image URL coverage and app/media content not represented by ordinary HTML.

The crawler's generic metadata feed stores public HTML pages by `pageKind` (news, video, gallery, ranking/statistics, schedule, archive, forecast, commentary, match graphs/highlights, player performance and related profile/team/series subpages). Use `GET /api/v1/content?kind=news` or `GET /api/v1/content?kind=video` to filter them. Each page payload includes title, canonical URL, meta tags, image URLs, media references, links, tables, labels, sections, controls, JSON-LD and bounded visible text where present.

## What the collector reads

The backend discovers **both men's and women's** match cards exposed by Cricbuzz's live, upcoming and recent indexes and immediately returns a lightweight JSON record for each discovered match. Women/WPL paths are not excluded by the URL allowlist or match-content filters. The shared cricket dataset includes women's fixtures, leagues (including WPL and WBBL), player and team profiles, and women-specific rankings. Any display filtering belongs in the consuming client, not in the shared scraper. The format classifier keeps Test, ODI, T20, T10, Sixes and The Hundred distinct. Detailed match facts, scorecard, squads, commentary and linked profiles are deep-scraped in a rotating, bounded request budget; deeper records replace their index-only stubs as the collector reaches them. Related-page URLs that do not fit a cycle's budget are retained in a bounded in-process queue while that API instance remains warm. It follows the navigation links exposed by each match page, rather than guessing private API endpoints:

- Match page: live score summary, match identity, competition, teams, format, result and match navigation.
- Info/facts: date/time text, venue, toss, officials, match facts and related venue/series links.
- Scorecard: innings totals, batting and bowling rows, extras breakdown, partnerships, fall of wickets and delivery-by-delivery records when the structured source data exposes them. The normalized `matchData` object keeps source fields and extraction-coverage signals.
- Squads: playing XI, bench/support-staff headings, player links and team images.
- Full commentary: structured delivery IDs, innings/over/ball coordinates, striker/non-striker/bowler, bat runs, extras, total runs, dismissal/fielder fields, event descriptions and commentary. The old parent-div wall-of-text heuristic has been removed.
- Player profiles: profile images, all source-labelled details, biography sections, teams, debut/role/style/date/height fields, career-stat tables and decoded React Server Component profile data. Common attributes have typed columns; additional source fields are retained in a typed attribute table and in immutable source evidence.
- Team and series pages: visible page metadata, image URLs, tables, labels, controls, links, sections, JSON-LD and page text. The JSON records the same-host links and tab controls exposed in the HTML. The collector does not recursively fetch every team/series tab or merge those pages into a `supplementalPages` field; related entity pages are fetched only when independently discovered through the bounded match-page collection cycle. Venue pages can include location, city, capacity, timezone, home team and records when an allowed venue page is discovered and the fields are present in its HTML.

Image assets are returned as Cricbuzz-hosted HTTPS URLs and metadata. The collector does not download video, replay streams, or bypass login, anti-bot checks or access controls. Generic page extraction preserves structured page content without claiming every page has the same schema.

## JSON API

All successful data endpoints return JSON with a `data` field and small `meta` object. Index discovery makes the full visible match list available immediately; the detail fields for matches, players, teams, series and venues are progressively enriched over successive collection cycles. Every entity contains `id`, `entityType`, `sourceUrl`, `fetchedAt`, `retentionClass` and `expiresAt`. `ttlSeconds` is 600 for ephemeral records and `null` for persistent records. Response metadata describes the shared retention policy.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Vercel API, Neon and crawler readiness |
| `GET /api/settings` | Current refresh cadence and crawler status |
| `PUT /api/settings` | Set refresh cadence (10, 15, 20 or 30 seconds) and enable/disable collection; server-side admin token required |
| `POST /api/refresh` | Run one collection cycle; server-side refresh token required and cadence enforced in Neon |
| `GET /api/v1/matches` | Match list with optional status and limit |
| `GET /api/v1/matches/:matchId` | Match detail |
| `GET /api/v1/matches/:matchId/events` | Match event timeline |
| `GET /api/v1/players`, `/teams`, `/series`, `/venues` | Entity feeds |
| `GET /api/v1/content?kind=news&limit=100` | Metadata-backed content feed (news/video/gallery/rankings/schedule/archive/etc.) |
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

The client exposes typed methods for live/upcoming/recent matches, match details and events, players, teams, series, venues, entity lookup, search and health checks. It uses JSON-only GET requests, disables browser HTTP caching, supports `AbortSignal`, URL-encodes IDs and surfaces structured HTTP errors. The browser must call the Crikora API, never Cricbuzz directly. Keep `DATABASE_URL` and Crikora's own admin/refresh secrets on the backend only. The public-HTML scraper does not need Cricbuzz-issued API credentials.



### Production API and fallback

**Primary API base (Vercel):**

`https://crikora.vercel.app/api`

Use Vercel as the normal production API origin for the website and browser extension. Keep Railway as the emergency deployment fallback only when Vercel cannot build or deploy because of a platform limit.

**Railway fallback API base:**

`https://crikora-api-production.up.railway.app/api`

When a Vercel build is blocked, switch the frontend's API base to the Railway URL for that deployment window. Switch it back to the Vercel URL after Vercel deployments are available again. Do not run both scraper schedulers simultaneously: Vercel holds the shared Neon worker lease when primary; the Railway worker stays in standby until explicitly enabled for fallback.

Public read routes include:

- `GET /health`
- `GET /v1/matches?status=live|upcoming|completed&limit=100`
- `GET /v1/matches/:matchId`
- `GET /v1/matches/:matchId/events`
- `GET /v1/players?limit=100` and `GET /v1/players/:id`
- `GET /v1/teams?limit=100` and `GET /v1/teams/:id`
- `GET /v1/series?limit=100` and `GET /v1/series/:id`
- `GET /v1/venues?limit=100` and `GET /v1/venues/:id`
- `GET /v1/content?kind=news|video|gallery&limit=100`
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

The permanent archive is an evidence-backed history layer separate from the current cache. It begins with every permitted current/saved sitemap URL, follows Cricbuzz's own scorecard-archive year links (including the source-published 1877 archive), then follows series, match, player, team, venue, news, statistics and media metadata links exposed by those pages. It does not synthesize missing years or claim that every statistic or delivery exists for every historical match.

- `crikora_entity_snapshots` stores every observed distinct normalized entity version. A later return to an earlier payload is stored as a new observation.
- `crikora_source_page_snapshots` stores source URL, page kind, SHA-256, original/compressed byte counts and an object key. The compressed HTML (including embedded React flight scripts) is stored in the private Neon Object Storage bucket `crikora-raw-archive`, not in PostgreSQL. Existing legacy `body_gzip` rows remain readable during migration. Low-churn pages are captured whenever content changes; high-churn match/live-analysis/index URLs are captured at most once per hour per URL. This does not throttle normalized entity snapshots.
- `crikora_archive_coverage` records discovered, pending, processing, captured, skipped and failed URLs by route family.
- `GET /v1/archive/coverage` reports the current archive coverage ledger.
- `GET /v1/archive/entities/:entityType` lists each entity's latest archived version with cursor pagination.
- `GET /v1/archive/entities/:entityType/:sourceId/history` lists immutable versions of one entity.

Use `CrikoraApiClient.getArchiveCoverage()`, `listArchivedEntities()` and `getEntityHistory()` from the website or extension. Browser clients receive normalized JSON only. They never receive database credentials or raw HTML storage access.

The archive crawl is continuous: after the durable backlog is drained, the existing worker keeps checking current match and section indexes, durably queues every indexed match URL for deep enrichment, and re-enqueues newly discovered pages. The live index feed remains on the configured 10–30-second cadence. Up to 10 already-captured match pages are scheduled for deep refresh per pass (live every 2 minutes; upcoming every 15 minutes), keeping facts, scorecards, squads and commentary current without flooding the historical queue. A large historical backfill can take substantial time. A coverage status of "captured" means that a permitted page was fetched and archived, not that every possible field was present on the page. Check extraction gaps and skipped/failed counts before declaring any route family complete.

## Backend-only Neon archive storage environment

The API uses these five variables to write compressed source HTML to the private Neon Object Storage bucket. They must be configured on the **core Crikora API project** (the repository-root Vercel project), not on the browser extension or website:

```dotenv
AWS_ENDPOINT_URL_S3=https://br-cold-bird-bdw51znf.storage.c-8.us-east-2.aws.neon.tech
AWS_REGION=us-east-2
AWS_ACCESS_KEY_ID=<NEON_STORAGE_TOKEN_ID>
AWS_SECRET_ACCESS_KEY=<NEON_STORAGE_S3_SECRET_ACCESS_KEY>
CRIKORA_ARCHIVE_BUCKET=crikora-raw-archive
```

Use the branch-scoped Neon Object Storage credential created for the `production` branch. `AWS_ACCESS_KEY_ID` is its `token_id`; `AWS_SECRET_ACCESS_KEY` is its `s3_secret_access_key`. Do not substitute the Neon API token. For local development, place the values in an untracked `.env` file. For Vercel, add them as encrypted/sensitive **Production** variables on the root API project and redeploy. The separate durable worker only calls the API and does not need the S3 secret. The frontend and browser extension must never receive any of these five variables.

The server imports `dotenv/config`, validates the five names, and calls `createArchiveObjectStoreFromEnv(process.env)` before constructing `PostgresEntityRepository`. If the variables are all absent in development, the legacy local bytea fallback is used; a partial set fails at startup; production requires all five. `GET /health` exposes only `archiveObjectStorage: "configured"` or the local fallback state, never secret values. This configuration flag is not a live upload/download test; verify a real private-bucket round trip before enabling the archive worker.

## Neon setup

A separate Neon project named `crikora` was created for cricket data. The existing `resolvX` support-bot database was left untouched.

1. Apply migrations `001_crikora_cache.sql` through `010_typed_source_identifiers_and_contributions.sql` to the Crikora production database, in numeric order. Migrations 007-010 are additive: archive evidence, typed player/match projections, detailed extras and player-identity fields.
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

**Vercel hosting note:** deploy the core API from the repository root and the durable scheduler as a separate Vercel project with root directory `crawler-worker`. A durable Vercel Workflow handles the 10/15/20/30-second schedule; a minute-based Cron job is not used as a substitute for a ten-second scheduler. The connected Vercel account currently exposes no linked Crikora project in the available deployment integration, so the intended Vercel project link and deployment still need verification in the dashboard. See [`crawler-worker/README.md`](./crawler-worker/README.md).

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

## Durable full-site crawl

The initial crawl merges the saved 4,721-URL snapshot with the current sitemap inventory, explicitly seeds the scorecard archive and cricket directories, then applies the all-gender cricket route allowlist; men's and women's cricket share the same dataset, and the raw sitemap count is not the number of queued cricket pages. Migration `004_crikora_durable_crawl.sql` adds a Neon-backed run and URL queue with lease recovery, retries and progress tracking. The worker drains one bounded historical page batch, then calls the lightweight `POST /api/refresh/index` route to keep live/upcoming/recent match summaries fresh while the backlog is still running.

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

To seed or resume the full sitemap crawl and then drain its durable queue:

```bash
npm run worker:local -- --start-crawl
```

`worker:local -- --once` performs one scheduler pass and exits. The standalone worker reads the enabled flag and refresh cadence from the API/Neon, follows API `Retry-After` responses, refreshes its Neon lease while sleeping, and stops cleanly on Ctrl+C. It does not start source collection while crawler settings are disabled.

The machine running this process must stay online for continuous scraping. It requires `DATABASE_URL`, `CRIKORA_API_BASE_URL`, `CRIKORA_ADMIN_SECRET` and `CRIKORA_REFRESH_SECRET` in the local server-only `.env` file. Never put these values in the browser extension or commit `.env`.