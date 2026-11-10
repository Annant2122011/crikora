# Crikora permanent historical archive and continuous ingestion architecture

## Objective

Maintain one Crikora-owned PostgreSQL data platform for (1) the latest normalized data used by the website and browser extension, and (2) an immutable record of every distinct public Cricbuzz page/entity version that Crikora is permitted to collect. New fixtures, match pages, player profiles, series, venues, news and other supported cricket pages are discovered continuously and added without overwriting the evidence already archived.

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
   - `crikora_entity_snapshots`: append-only normalized entity versions, de-duplicated by a canonical content hash.
   - `crikora_source_page_snapshots`: append-only gzip-compressed raw HTML versions, de-duplicated by URL and SHA-256.
   - `crikora_archive_coverage`: persistent URL-level status, attempt, fetch and version counters.
   These evidence tables are not touched by cache cleanup. Database triggers reject UPDATE and DELETE on the two snapshot tables.
6. **Public product API**: website and extension read only the Crikora JSON API. They never receive database/source credentials and never scrape Cricbuzz directly.

## Permanent-retention rules

- Every distinct normalized payload hash is inserted once per entity identity.
- Every distinct raw HTML hash is inserted once per canonical source URL.
- Identical refreshes update last-seen/coverage timestamps but do not duplicate archive bytes.
- New/changed scorecards, commentary, player profiles, team pages, fixtures, news and statistics create new evidence versions.
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
8. Keep the existing durable worker draining the backlog in bounded batches. After the backlog is complete, each refresh cycle checks current/live/upcoming/recent indexes, archives changed page versions, and enqueues newly discovered follow-up URLs.

Archive page links are the source of truth for historical coverage. If a linked page is denied, redirected, missing, challenge-protected or not exposed, record the result rather than bypassing it.

## Continuous mode

The Vercel durable workflow remains the scheduler. It processes the durable archive queue before returning to refresh cycles. The core API's database lease serializes refresh requests across serverless instances. The minimum source-request interval is separate from the user-facing refresh cadence. Respect Retry-After on 429; stop or pause on access challenges/403; bounded retry/backoff only for transient 5xx/network failures.

A full historical archive may take hours or days depending on page count, upstream latency, source throttling and the completeness of series/player link discovery. Do not run competing worker schedulers against the same database. The Neon worker lease remains the single-owner guard.

## Field completeness and parser discipline

- Retain raw HTML for reprocessing when Cricbuzz changes its page markup.
- Retain embedded Next.js/React flight data as structured evidence, not just visible text.
- Normalize match, innings, delivery, batter, bowler, player, team, series, venue, news, ranking, statistics, archive and media metadata into explicit schema versions.
- Preserve unknown source fields in the raw capture/RSC payload rather than discarding them.
- Never substitute guessed values for missing fields. Emit null/absent and report extraction gaps.
- Field-level acceptance tests must compare parsed values with captured source fixtures for each route family and every format.
- Current regex commentary detection is a fallback only. It is not a verified delivery parser.

## API additions

- `GET /v1/archive/coverage`: counts of discovered/captured/skipped/failed URLs by route family, plus total raw-page and entity-version counts.
- `GET /v1/archive/entities/:entityType/:sourceId/history`: permanent normalized history for one entity.
- Raw HTML is never returned by a public route. A future authenticated export/restore interface must be separately designed.
- Existing API routes continue to serve the latest entity from `crikora_cache`.

## Product scope

The underlying capture schema can preserve all supported source categories, but the Crikora product's established scope is men's cricket. Product filtering belongs in the API/query layer; source authorization and source restrictions always take precedence. If scope is changed later, it must be an explicit product decision and not an accidental parser side effect.

## Deployment and acceptance gates

1. Apply migrations 001-007 in order on the Crikora Neon branch. Do not run destructive migrations or reset the database.
2. Deploy the API and one durable worker only after CI passes.
3. Verify health, database ping, migration presence, API history/coverage routes and worker lease.
4. Run a small archive probe (1877, one modern season, one live match, a player profile, a venue, a news article). Compare source-page count, parsed field counts and extracted values.
5. Start the full archive crawl only after authorization, schema and capacity checks. Watch queue progress, page-kind coverage, failures, source denials, snapshot bytes and database storage.
6. Do not call the archive "complete" until every discoverable source URL has a terminal outcome and all known extraction gaps are documented. A queue-completed status alone is insufficient.
