# Targeted durable Crikora collection

## Product scope

Crikora collects only four Cricbuzz data families. This is not a generic mirror of the Cricbuzz website.

| Family | Collection |
|---|---|
| Match centre | Match overviews, facts, scorecards, squads, innings, batting/bowling rows, extras, partnerships, fall of wickets, commentary and structured deliveries dated **4 November 2026 onward** |
| Player profiles | All profiles surfaced by the Cricbuzz player-profile sitemap, plus players discovered from match squads and relevant fixture/article pages. Preserve every exposed labelled field, biography section, image, table, JSON-LD field and React Server Component (RSC) profile datum. |
| Schedule | Upcoming/all-series indexes and the fixtures linked from them, including match URL, teams, format, competition, date/time and venue when present. |
| News | All article URLs listed by Cricbuzz's cricket-news sitemap, with full available body text, summary, author, published/modified timestamps, category, image, tags and raw page evidence. |

Both men's and women's cricket are included across all four families. The date cutoff does not apply to player profiles, the schedule or news. Older ball-by-ball matches are not fetched from Cricbuzz; those will be imported separately from Cricsheet.

The saved sitemap audit is retained only as a fallback inventory for 303 player profile URLs and 770 news article URLs. It is not merged with the root sitemap. A normal run fetches only the player and news sitemap documents plus the match and schedule/news index pages. Team directories, rankings, video, galleries, old scorecard archives, historical matches before the cutoff and unrelated site URLs are excluded.

## How the bounded discovery works

- Match index pages discover match IDs. Completed matches older than the cutoff are not queued for detail enrichment.
- Each eligible match overview fetches its same-ID facts, scorecard, squads and full-commentary pages directly. These pages are archived as part of that match fetch, not re-queued as duplicate jobs.
- Match squads and profile links discover players. A profile can lead only to that player's own batting/bowling/all-matches tabs; related-player carousels are not crawled.
- Schedule and series indexes discover fixtures and match pages.
- News indexes discover article URLs. Articles never recurse to other articles.
- All requests are HTTPS, same-host, sequential, size/time bounded and source-response aware. A page-level 4xx or challenge is isolated as skipped; 429 honors `Retry-After`; transient 5xx/network failures use bounded retry/backoff. No challenge or access control is bypassed.

## Player profile model

The canonical player entity retains the source identity, profile title, image references, source-labelled `allFields`, normalized common fields, biography sections, teams, career-stat tables and decoded RSC structures. Migration 008 supplies a typed attribute table where each field retains its source path, label, value type and text/numeric/date/boolean/JSON representation. Nested objects and arrays are kept whole as JSON and scalar leaves are individually queryable. Original strings are preserved alongside normalized values.

A profile's linked career tabs are stored as related metadata pages and available through the entity-details API. The client should render all source-labelled fields rather than hardcode a fixed list of labels. This is important because Cricbuzz may add or rename fields.

The collector archives the full fetched HTML, including embedded RSC data. This preserves evidence for later parser improvements, but it cannot guarantee values that Cricbuzz only returns after client-side interaction or through inaccessible/authenticated endpoints. Missing data is not fabricated.

## Match model

The match entity stores source and normalized fields. Migrations 008–010 provide typed projections for innings, batting/bowling, extras, partnerships, fall-of-wickets, deliveries and commentary. Available delivery fields include source IDs for batter, non-striker, bowler, dismissed player and fielder; over/ball coordinates; bat runs; byes, leg-byes, wides, no-balls and penalty; total runs; dismissal type; descriptions and commentary timestamps.

A delivery sequence is not labelled complete merely because some balls were extracted. Coverage metadata distinguishes data that is present but unverified from fields not exposed by the source.

## News and schedule models

Migration 011 creates two dedicated read models:

- `crikora_news_articles`: source/canonical URLs, title, summary, full available body text, author, category, published/modified times, image URL, tags and raw metadata. It has published/category and full-text indexes.
- `crikora_schedule_fixtures`: fixture and match IDs, source page, match URL/title, teams, competition, format, start time, venue, source text and raw fixture JSON.

## Migrations

Apply migrations `001` through `011` in numeric order to the production Neon branch. Migrations 007–010 add the append-only source archive and typed cricket projections; migration 011 adds the explicit collection scope and news/schedule read models. Migration 003 creates the singleton worker state used by the durable workflow. All migrations are additive and the previous broad crawl queue is retained as a paused audit record, not deleted.

## API routes

The base URL ends in `/api`.

| Method | Route | Authentication | Purpose |
|---|---|---|---|
| GET | `/health` | Public | API, database and archive-storage configuration status |
| POST | `/crawl/start` | `CRIKORA_ADMIN_SECRET` | Create or resume the targeted product crawl; pause legacy broad run |
| GET | `/crawl/status` | `CRIKORA_ADMIN_SECRET` | Run progress and family counts |
| POST | `/crawl/step` | `CRIKORA_REFRESH_SECRET` | Process one bounded queue batch |
| POST | `/refresh/index` | `CRIKORA_REFRESH_SECRET` | Lightweight match-index refresh |
| GET | `/v1/matches` | Public | Paginated match feed |
| GET | `/v1/players` | Public | Paginated player directory |
| GET | `/v1/entities/player/:id/details` | Public | Player profile plus linked stats tabs |
| GET | `/v1/players/compare?ids=id1,id2` | Public | Compare 2–4 profiles by source-labelled fields |
| GET | `/v1/schedule` | Public | Paginated fixture schedule |
| GET/GET by ID | `/v1/news`, `/v1/news/:id` | Public | Full news feed and article detail |
| GET | `/v1/archive/coverage` | Public | Captured/skipped/failed page coverage |

The separate worker management route `POST /v1/crawl/start` uses `CRIKORA_WORKER_ADMIN_SECRET`; it calls the protected core API and starts the durable scheduler. Browser code only calls public JSON read endpoints.

## Vercel primary and Railway fallback

**Vercel is primary.** The root Vercel project builds the API functions using root `vercel.json`; the second Vercel project builds `crawler-worker/` using its own Nitro configuration. The root API requires `DATABASE_URL`, admin/refresh secrets, `CRIKORA_COLLECTION_ENABLED`, the 4 November 2026 cutoff, and all five private Neon Object Storage variables. The worker requires the API URL, same Neon database, shared admin/refresh secrets and its separate worker-admin secret. The storage keys belong on the core API only, never on the worker, website or extension.

**Railway is backup.** Its `crikora-api` and `crikora-worker` services build the same repository with `npm run build:railway`. The Railway API also requires all five private Neon Object Storage variables because the production repository fails fast without object storage. The API performs an optional startup PUT/GET round trip when `CRIKORA_VERIFY_ARCHIVE_STORAGE_ON_START=true`. The Railway worker remains disabled while Vercel is primary.

Both engines use the same Neon database and singleton worker lease. Never run both worker schedulers simultaneously. Before a Railway failover, stop/disable the Vercel worker, verify its lease is released, then enable the Railway API collection switch and Railway worker. To return to Vercel, stop Railway first and then enable the Vercel worker.

## Safe start sequence

1. Confirm migrations 001–011 are applied on Neon production.
2. Configure the Vercel core API environment and verify `archiveObjectStorage: "configured"`.
3. Run `npm run archive:verify-storage` against the configured API environment, or enable the one-time Railway startup diagnostic. Confirm a byte-for-byte PUT/GET result before enabling collection.
4. Confirm the Vercel worker can reach the core API and Neon worker-state table.
5. Keep `CRIKORA_COLLECTION_ENABLED=false` until both API and scheduler health checks pass.
6. Enable collection on the selected API runtime and call the worker's `POST /v1/crawl/start`.
7. Inspect `/crawl/status`, `/v1/archive/coverage`, and the player/news/schedule endpoint counts.

The crawl is deliberately not launched by CI or deployment startup. This prevents an unverified storage adapter or duplicated schedulers from starting a large source collection unexpectedly.
