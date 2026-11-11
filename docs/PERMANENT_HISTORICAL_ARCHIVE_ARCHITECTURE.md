# Crikora permanent historical archive and continuous ingestion architecture

## Objective

Maintain one Crikora-owned PostgreSQL data platform for (1) the latest normalized data used by the website and browser extension, and (2) an immutable record of every distinct public Cricbuzz page/entity version that Crikora is permitted to collect. Crikora's product scope is **both men's and women's cricket**; daily-news selection in ChatGPT is a separate workflow and does not impose a gender filter on this dataset. New fixtures, match pages, player profiles, series, venues, news and other supported cricket pages are discovered continuously and added without overwriting the evidence already archived.

This design does not claim that every fact has been published by Cricbuzz. The collector can only archive fields and records that are actually exposed by accessible source pages. A source coverage ledger must distinguish discovered, captured, skipped, failed and not-yet-discovered pages.

## Verified historical starting point

Cricbuzz's own public scorecard archive exposes an archive page for 1877 and links to the "England in Australia Test Series, 1877" (two Tests, March 16-April 3). The 1877 archive page also links to the historical years it exposes. Therefore 1877 is a verified archive starting point for at least that series, not a guarantee that every match, player field, delivery, article or statistic from 1877 onward is present. See:
- https://www.cricbuzz.com/cricket-scorecard-archives/1877
- https://www.cricbuzz.com/cricket-series/1012/england-in-australia-test-series-1877/matches

The historical crawl must take the year links and match/series links from the source itself. It must not manufacture missing years or infer that every year has matches. The current archive menu has gaps in years, so a gap must be reported as "not listed by source", not silently filled.

## Product and storage layers

1. **Source discovery**: current Cricbuzz sitemaps, archive year pages, series directories, team directories, player directories and match indexes.
2. **Durable URL inventory/queue**: existing `crikora_crawl_runs` and `crikora_crawl_queue`, with stable identity keys, leases, retry-after handling and safe same-host allowlisting.
3. **Extraction**: existing TypeScript/Cheerio parser, expanded to retain React Server Component payloads and complete raw HTML page versions. Normalized field-specific parsers are layered on top of captured evidence.
4. **Current serving cache**: existing `crikora_cache`, still used by the JSON API. Volatile live records may expire after 600 seconds; stable records have no TTL. It is a serving cache, not the archive.
5. **Permanent evidence archive** (migration 007):
   - **Typed current projections** (migration 008): normalized player profile columns, extensible typed player attributes and statistic rows, plus separate innings, batting, bowling, extras, partnerships, fall-of-wicket, delivery and commentary tables.
   - **Typed source identity/contribution extensions** (migration 010): player IDs on delivery, dismissal and fielding rows; individual batter contribution fields on partnerships; and stable source paths for player-stat metrics. These are transactionally refreshed read models; immutable entity snapshots preserve historical versions.
   - `crikora_entity_snapshots`: append-only normalized entity versions, de-duplicated by a canonical content hash.
   - `crikora_source_page_snapshots`: append-only source-page metadata, content SHA-256, original HTML byte count, compressed byte count and a content-addressed `object_key`.
   - Private Neon Object Storage bucket `crikora-raw-archive`: immutable-by-convention gzip HTML objects addressed by SHA-256; the object key is indexed in PostgreSQL. Existing legacy `body_gzip` rows remain supported during migration.
   - `crikora_archive_coverage`: persistent URL-level status, attempt, fetch and version counters.
   These evidence tables are not touched by cache cleanup. Database triggers reject UPDATE and DELETE on the normalized and raw-page metadata snapshot tables. The application has no archive-delete operation; object storage credentials must remain server-side.
6. **Public product API**: website and extension read only the Crikora JSON API. They never receive database/source credentials and never scrape Cricbuzz directly.

## Permanent-retention rules

- Every distinct normalized payload hash is inserted once per entity identity.
- Raw HTML is compressed and kept as reprocessing evidence. Static/low-churn pages are archived whenever their content changes; high-churn match/live-analysis pages are stored at most once per hour per URL. Every normalized entity change is still archived independently, so delivery/score/profile changes are not lost merely because the raw HTML snapshot cadence is throttled.
- Identical refreshes update last-seen/coverage timestamps but do not duplicate archive bytes. Collector-generated observation timestamps are excluded from entity content hashes to prevent false versions.
- New/changed normalized scorecards, commentary, player profiles, team pages, fixtures, news and statistics create new entity evidence versions. High-churn raw HTML is sampled hourly per URL to keep permanent evidence storage sustainable.
- The live serving cache may still expire volatile rows. This does not delete archive snapshots.
- No TTL, cleanup function or cache migration may delete from either snapshot table.
- Stable latest entities are still upserted in `crikora_cache`; historical versions remain in the snapshot table.
- Backups and object-level database retention are still required. "Permanent" means no application expiry/deletion; it is not a substitute for Neon backup/PITR and independent exports.

## Historical discovery and crawl order

1. Seed all allowlisted pages from current sitemap documents and the saved sitemap inventory.
2. Crawl `/cricket-scorecard-archives`, then every year link actually published by that page, beginning with the oldest available year (currently 1877).
3. Crawl each series link from each year page; follow series match tabs and match links.
4. Crawl each match overview and all source-linked companion tabs: facts, scorecard, squads, commentary, graphs/highlights and any other accessible match subpages.
5. Crawl player, team, series, venue and news links found on those pages and directories.
6. Crawl supported news/article, video metadata, photo gallery, ranking, statistics, records, schedule, points-table and auction routes.
7. Persist every successful raw page and normalized entity. Record each URL outcome in the coverage ledger.
8. Keep the existing durable worker draining the backlog in bounded batches. After each archive batch, the worker calls the authenticated `/refresh/index` route, which fetches only live/upcoming/recent match indexes and writes lightweight latest-match summaries. This keeps the live catalogue refreshing on the configured 10–30-second cadence while deep historical work continues. If Cricbuzz returns a 429/Retry-After or an upstream 5xx, the worker pauses the source calls for the indicated backoff rather than hammering the site. Every index refresh also enqueues newly visible match URLs and schedules a bounded set of already-captured live/upcoming match pages for deep enrichment (live matches every 2 minutes, upcoming matches every 15 minutes). The durable Neon crawl queue, not process memory, is the source of truth for pending work.

Archive page links are the source of truth for historical coverage. If a linked page is denied, redirected, missing, challenge-protected or not exposed, record the result rather than bypassing it.

## Continuous mode

The Vercel durable workflow remains the single scheduler. Each cycle processes one bounded historical page batch and then calls the lightweight `/refresh/index` route so the live fixture list continues updating during backfill. The core API's database lease serializes refresh requests across serverless instances. The minimum source-request interval is separate from the user-facing refresh cadence. Respect Retry-After on 429; stop or pause on access challenges/403; bounded retry/backoff only for transient 5xx/network failures.

A full historical archive may take hours or days depending on page count, upstream latency, source throttling and the completeness of series/player link discovery. Do not run competing worker schedulers against the same database. The Neon worker lease remains the single-owner guard.

## Field completeness and parser discipline

- Retain raw HTML for reprocessing when Cricbuzz changes its page markup.
- Retain embedded Next.js/React flight data as structured evidence, not just visible text.
- Normalize match, innings, delivery, batter, bowler, player, team, series, venue, news, ranking, statistics, archive and media metadata into explicit schema versions.
- Preserve unknown source fields in the raw capture/RSC payload rather than discarding them.
- Never substitute guessed values for missing fields. Emit null/absent and report extraction gaps.
- Field-level acceptance tests must compare parsed values with captured source fixtures for each route family and every format.
- The dedicated `cricbuzz-structured.ts` parser reads Cricbuzz React flight data, JSON-LD, semantic HTML tables and explicitly marked commentary elements. Player profiles retain nested arrays/objects as JSON-valued typed attributes while also flattening scalar leaves to typed text/numeric/date/boolean attributes; career metrics are also stored as queryable metric rows with their source paths. The match parser keeps description and commentary distinct and extracts player source IDs, dismissal/fielder identities, individual extras, partnership batter contributions, fall-of-wicket rows and delivery coordinates. Each delivery/commentary item keeps its raw source record in `rawData` for parser upgrades.
- The match payload exposes `matchData.coverage` with per-page parser signals. A parsed delivery list is marked `present-unverified`, not complete, unless Cricbuzz publishes a verifiable sequence/total. If the source does not expose ball-by-ball data, the collector records `not-exposed`; it must not infer missing balls from wall text.
- Player core fields are typed PostgreSQL columns; additional source labels and RSC paths use a typed attribute table (text/numeric/date/boolean/JSON), so new Cricbuzz labels do not require a migration for every label. Career/stat table cells are separately queryable by metric label and numeric value.

## API additions

- `GET /v1/archive/coverage`: counts of discovered/captured/skipped/failed URLs by route family, plus total raw-page and entity-version counts.
- `GET /v1/archive/entities/:entityType/:sourceId/history`: permanent normalized history for one entity.
- `GET /v1/entities/:entityType/:sourceId/details`: latest entity record plus its linked statistics/profile subpages, resolved through `relatedEntityType` and `relatedSourceId`.
- Raw HTML is never returned by a public route. A future authenticated export/restore interface must be separately designed.
- Existing API routes continue to serve the latest entity from `crikora_cache`.

## Product scope

Crikora covers **both men's and women's cricket** across the website, browser extension, API, discovery indexes, historical archive, match pages, player/team profiles and statistics. WPL, WBBL and women's international/domestic cricket are included when Cricbuzz exposes the relevant public route. The shared API does not apply a gender filter; any optional presentation filter belongs in the consuming website or extension. Daily-news selection in ChatGPT is a separate workflow and does not narrow Crikora's dataset.

## Deployment and acceptance gates

1. Apply migrations 001-010 in order on the Crikora Neon branch. Migration 007 provisions immutable raw evidence; migration 008 adds typed current projections; migration 009 adds the per-delivery extras breakdown; migration 010 adds typed source player identifiers and individual partnership contributions. Do not run destructive migrations or reset the database.
2. Deploy the API and one durable worker only after CI passes.
3. Verify health, database ping, migration presence, API history/coverage routes and worker lease.
4. Run a small archive probe (1877, one modern season, one live match, a player profile, a venue, a news article). Compare source-page count, parsed field counts and extracted values.
5. Configure all five object-storage environment variables in the **core API** production environment before collection is enabled. `AWS_ACCESS_KEY_ID` is the Neon storage credential's `token_id`; `AWS_SECRET_ACCESS_KEY` is its `s3_secret_access_key`. `createArchiveObjectStoreFromEnv()` validates that all five values are present before constructing the SigV4 client. Never expose them to the extension or frontend. Apply migration 007 and 008, confirm the private bucket and test a live object upload/download.
6. Start the full archive crawl only after authorization, schema and capacity checks. Watch queue progress, page-kind coverage, failures, source denials, original HTML bytes, compressed object bytes, entity versions and Neon database storage.
7. Do not call the archive "complete" until every discoverable source URL has a terminal outcome and all known extraction gaps are documented. A queue-completed status alone is insufficient.
