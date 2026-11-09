# Crikora

Crikora is a cricket data collector and JSON API for the Crikora browser extension and website.

## Sitemap-backed content inventory

On 8 November 2026, the latest sitemap-included URL map returned **4,721 unique URLs** (the request cap was 10,000). The saved inventory is [`docs/cricbuzz-sitemap-inventory.json`](./docs/cricbuzz-sitemap-inventory.json). This is an indexed URL map, not a full HTML-body crawl or a guarantee that every dynamically generated or authenticated URL is listed. The count changes as Cricbuzz updates its sitemap.

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

The backend discovers supported men's and women's match cards exposed by Cricbuzz's live, upcoming and recent indexes and immediately returns a lightweight JSON record for each discovered match. The shared cricket dataset includes women's fixtures, leagues (including WPL and WBBL), player and team profiles, and women-specific rankings. Any display filtering belongs in the consuming client, not in the shared scraper. The format classifier keeps Test, ODI, T20, T10, Sixes and The Hundred distinct. Detailed match facts, scorecard, squads, commentary and linked profiles are deep-scraped in a rotating, bounded request budget; deeper records replace their index-only stubs as the collector reaches them. Related-page URLs that do not fit a cycle's budget are retained in a bounded in-process queue while that API instance remains warm. It follows the navigation links exposed by each match page, rather than guessing private API endpoints:

- Match page: live score summary, match identity, competition, teams, format, result and match navigation.
- Info/facts: date/time text, venue, toss, officials, match facts and related venue/series links.
- Scorecard: innings, batting and bowling rows, player scores, overs, boundaries and wickets where the page markup exposes them.
- Squads: playing XI, bench/support-staff headings, player links and team images.
- Full commentary: visible delivery commentary and explicit boundary/wicket events.
- Player profiles: profile images, flag images, personal details, teams, summary and available career/stat tables.
- Team and series pages: visible page metadata, image URLs, tables, labels, controls, links, sections, JSON-LD and page text. The JSON records the same-host links and tab controls exposed in the HTML. The collector does not recursively fetch every team/series tab or merge those pages into a `supplementalPages` field; related entity pages are fetched only when independently discovered through the bounded match-page collection cycle. Venue pages can include location, city, capacity, timezone, home team and records when an allowed venue page is discovered and the fields are present in its HTML.

Image assets are returned as Cricbuzz-hosted HTTPS URLs and metadata. The collector does not download video, replay streams, or bypass login, anti-bot checks or access controls. Generic page extraction preserves structured page content without claiming every page has the same schema.

## JSON API

All successful data endpoints return JSON with a `data` field and small `meta` object. Index discovery makes the full visible match list available immediately; the detail fields for matches, players, teams, series and venues are progressively enriched over successive collection cycles. Every entity contains `id`, `entityType`, `sourceUrl`, `fetchedAt`, `expiresAt` and `ttlSeconds: 600`, alongside its normalized fields and page-derived payload.

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

const crikora = new CrikoraApiClient("https://YOUR-CRIKORA-API.example/api");
const { data: liveMatches } = await crikora.listLiveMatches();
const { data: match } = await crikora.getMatch(liveMatches[0]!.id);
const { data: players } = await crikora.listPlayers();

// Refresh is a protected server-to-server POST, not a browser request.
// The API's CRIKORA_REFRESH_SECRET must never be bundled into the extension.
```

The client exposes typed methods for live/upcoming/recent matches, match details and events, players, teams, series, venues, entity lookup, search and health checks. It uses JSON-only GET requests, disables browser HTTP caching, supports `AbortSignal`, URL-encodes IDs and surfaces structured HTTP errors. The browser must call the Crikora API, never Cricbuzz directly. Keep `DATABASE_URL`, source credentials and provider secrets on the backend only.

## Ten-minute retention

Every JSON entity is assigned a database expiry exactly ten minutes after it is fetched/refreshed:

- PostgreSQL stores normalized records as JSONB.
- Reads always filter out records whose `expires_at` is in the past.
- The local long-running API deletes expired rows every 5 seconds and performs cleanup on startup.
- Reads never return expired rows, even if the cleanup scheduler is temporarily unavailable.
- A Neon scheduled Function calls the authenticated core API cleanup endpoint every minute, independently of scraper activity and compatible with scale-to-zero.
- Successful upserts refresh the ten-minute window for records seen again.

The in-memory development repository follows the same ten-minute expiry contract. No permanent historical archive is kept by this cache.

## Neon setup

A separate Neon project named `crikora` was created for cricket data. The existing `resolvX` support-bot database was left untouched.

1. Apply migrations `001_crikora_cache.sql` through `004_crikora_durable_crawl.sql` to the Crikora production database.
2. Set the **pooled** Neon connection string in the backend environment as `DATABASE_URL`. Do not put it in the browser extension or commit it.
3. Keep `CRICBUZZ_AUTOMATION_AUTHORIZED=false` until the deployed API and worker have passed their health checks and the source request policy is confirmed. Enable collection only when operationally ready.
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

Refresh cadence and source-request pacing are separate. `POLL_INTERVAL_SECONDS` controls the local long-running server. On Vercel, the durable worker reads `refresh_interval_seconds` from Neon. `CRICBUZZ_MIN_REQUEST_INTERVAL_MS` controls spacing between individual source requests and defaults to zero; the supplied email transcription does not state a numerical request interval. HTTP 401, 403, 429, redirects and access challenges still stop or pause the collection cycle; the crawler does not evade them.

**Vercel hosting note:** deploy the API from the repository root and the scheduler as a separate Vercel project with root directory `crawler-worker`. Vercel Cron on the current Hobby team is not a 10-second scheduler, so the worker uses the durable Workflow SDK instead. The Vercel project-creation API returned HTTP 403 in this session; the repository is prepared, but the Vercel projects have not been created or deployed. See [`crawler-worker/README.md`](./crawler-worker/README.md).

## Technical safety and known limits

- All page requests are sequential, same-host HTTPS, timeout bounded, and response-size bounded.
- 401, 403, 429, unexpected redirects and CAPTCHA/anti-bot pages fail closed. The scraper does not attempt to evade them.
- Links are host-checked and constrained to known Cricbuzz match, profile, team, series, news, video, gallery, statistics, schedule, commentary and special-content route families.
- Images are exposed as external URLs. They are not copied to Crikora object storage.
- HTML schemas can change. Keep representative fixtures and re-run the parser tests when Cricbuzz changes markup.
- This is a static-HTML collector, not a full browser automation engine. It does not execute Cricbuzz client-side JavaScript, trigger interactive tabs, or retrieve data that only appears after browser-side hydration. Some profile tabs, charts, or statistics may therefore be absent. The collector returns fields and links it can verify in the fetched HTML and does not fabricate missing values.
- The database cache is a ten-minute feed cache, not a historical score archive.

## CI

GitHub Actions runs typecheck, build and tests on pushes and pull requests to `main`.

## Durable full-site crawl

The initial crawl uses the sitemap inventory in `docs/cricbuzz-sitemap-inventory.json` (4,721 discovered URLs, filtered by the same-host allowlist). Migration `004_crikora_durable_crawl.sql` adds a Neon-backed run and URL queue with lease recovery, retries and progress tracking. The worker starts it with `POST /v1/crawl/start` and drains it in bounded sequential batches before returning to live refresh.

- Core API: `POST /api/crawl/start`, `GET /api/crawl/status`, `POST /api/crawl/step`, `POST /api/cleanup`.
- Worker: `POST /v1/crawl/start` (requires the worker admin bearer token).
- The cache payloads still expire after 600 seconds. The durable queue retains URLs and operational status only, not page contents. This is a live cache and a multi-hour crawl, not a permanent historical snapshot. A complete cross-provider snapshot would require a separate, explicit archive/export retention policy.
- The collector reads static HTML and only public pages it can fetch. It does not execute browser JavaScript, authenticate into restricted areas, bypass CAPTCHA or source denials, or download video streams.

See [the durable crawl runbook](./docs/DURABLE_FULL_CRAWL.md) for the complete route and deployment setup.
