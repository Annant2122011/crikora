# Crikora

Crikora is a cricket data collector and JSON API for the Crikora browser extension and website.

## What the collector reads

The backend discovers public match pages from Cricbuzz's live, upcoming and recent indexes. It follows the navigation links exposed by each match page, rather than guessing private API endpoints:

- Match page: live score summary, match identity, competition, teams, format, result and match navigation.
- Info/facts: date/time text, venue, toss, officials, match facts and related venue/series links.
- Scorecard: innings, batting and bowling rows, player scores, overs, boundaries and wickets where the page markup exposes them.
- Squads: playing XI, bench/support-staff headings, player links and team images.
- Full commentary: visible delivery commentary and explicit boundary/wicket events.
- Player profiles: profile images, flag images, personal details, teams, summary and available career/stat tables.
- Team, series and venue pages: visible page metadata, image URLs, tables, labels, links, sections, JSON-LD and page text. Venue pages can include location, city, capacity, timezone, home team and records when exposed by the page.

Image assets are returned as Cricbuzz-hosted HTTPS URLs and metadata. The collector does not download video, replay streams, or bypass login, anti-bot checks or access controls. Generic page extraction preserves structured page content without claiming every page has the same schema.

## JSON API

All successful data endpoints return JSON with a `data` field and small `meta` object. Every entity contains `id`, `entityType`, `sourceUrl`, `fetchedAt`, `expiresAt` and `ttlSeconds: 600`, alongside its normalized fields and page-derived payload.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | API, source and storage readiness |
| `GET /v1/matches?status=live|upcoming|completed&limit=100` | Match list |
| `GET /v1/matches/live` | Live matches |
| `GET /v1/matches/upcoming` | Upcoming matches |
| `GET /v1/matches/recent` | Completed/recent matches |
| `GET /v1/matches/:matchId` | Full match JSON |
| `GET /v1/matches/:matchId/events` | Match event timeline |
| `GET /v1/players?limit=100` | Player profiles and images |
| `GET /v1/teams?limit=100` | Team data |
| `GET /v1/series?limit=100` | Series pages |
| `GET /v1/venues?limit=100` | Venue/location data |
| `GET /v1/entities/:entityType` | Generic entity list |
| `GET /v1/entities/:entityType/:sourceId` | One entity |
| `GET /v1/search?q=india` | Search cached JSON payloads |

Match IDs in the API can be passed with or without the `cricbuzz:` prefix. Use the numeric Cricbuzz source ID for player/team/series/venue entity routes.

## Ten-minute retention

Every JSON entity is assigned a database expiry exactly ten minutes after it is fetched/refreshed:

- PostgreSQL stores normalized records as JSONB.
- Reads always filter out records whose `expires_at` is in the past.
- The cleanup worker physically deletes expired rows every 5 seconds while the API is running.
- Startup cleanup removes expired rows left behind during a restart or outage.
- Upserts refresh the ten-minute window for records seen again.

The in-memory development repository follows the same ten-minute expiry contract. No permanent historical archive is kept by this cache.

## Neon setup

A separate Neon project named `crikora` was created for cricket data. The existing `resolvX` support-bot database was left untouched.

1. Apply `migrations/001_crikora_cache.sql` to the new Crikora database.
2. Set the **pooled** Neon connection string in the backend environment as `DATABASE_URL`. Do not put it in the browser extension or commit it.
3. Set `SOURCE_MODE=cricbuzz` and `CRICKET_SOURCE_ENABLED=true` only after the approved source request limits have been entered.
4. Set `CORS_ORIGINS` to the exact deployed website origin and Chrome extension origin.

The API refuses to start in Cricbuzz mode without `DATABASE_URL`. Demo mode can run with the memory repository.

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

## Scraper configuration

`POLL_INTERVAL_MS` controls how often an ingestion cycle starts. `CRICBUZZ_MIN_REQUEST_INTERVAL_MS` spaces individual requests. Additional per-cycle limits keep the crawler bounded and allow match/profile collection to rotate across cycles. Defaults in `.env.example` are conservative placeholders; replace them with the exact numerical limits from the written Cricbuzz authorization. Do not lower the pacing or increase concurrency beyond those limits.

## Technical safety and known limits

- All page requests are sequential, same-host HTTPS, timeout bounded, and response-size bounded.
- 401, 403, 429, unexpected redirects and CAPTCHA/anti-bot pages fail closed. The scraper does not attempt to evade them.
- Links are host-checked and constrained to the Cricbuzz match, profile, team, series and venue page routes.
- Images are exposed as external URLs. They are not copied to Crikora object storage.
- HTML schemas can change. Keep representative fixtures and re-run the parser tests when Cricbuzz changes markup.
- Some player profile tabs or chart data may be loaded dynamically and won't exist in the initial static HTML. The collector returns all page content and links it can verify, but does not fabricate missing values.
- The database cache is a ten-minute feed cache, not a historical score archive.

## CI

GitHub Actions runs typecheck, build and tests on pushes and pull requests to `main`.
