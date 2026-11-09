# Stage 1: Cricbuzz source coverage audit

**Audit date:** 9 November 2026  
**Repository branch:** `stage-1-live-sitemap-discovery`  
**Production crawler:** Not started by this audit  
**Retention policy:** Unchanged at 600 seconds

## Executive finding

The existing 8 November saved URL map contains 4,721 unique URLs across 30 route families. It was a sitemap-included URL map, not a full page-body crawl and not proof that all indexed, dynamically generated, private or authenticated content was enumerated.

A fresh sitemap-only map on 9 November returned 4,393 unique URLs. After URL normalization, 85 URLs appeared in the fresh map but not the saved snapshot, while 413 URLs from the saved snapshot were absent from the fresh map. Those 413 are not assumed to be dead; the implementation retains the saved snapshot and unions it with the newly discovered public sitemap URLs.

The first cricket-only allowlist accepted 4,388 of the 4,393 current map URLs and left out five sitemap-listed site pages (the homepage, a public premium account-info landing route, two information pages and a careers page). Stage 1 now explicitly accepts those exact public sitemap-index page paths as generic metadata pages too. The current sitemap-only map's 4,393 unique page URLs are therefore all seed-eligible after exact-host and HTTPS validation. This does not authenticate a user or follow redirects; redirected pages are recorded as skipped. Sitemap XML documents remain discovery metadata rather than page entities.

## Current public sitemap documents inspected

The public `/sitemap.xml` document referenced 12 sitemap XML documents. Each document was fetched independently for this audit. The following counts are raw `<loc>` entries returned from each document, before cross-document deduplication and page allowlist filtering.

| Sitemap document | `<loc>` entries |
| --- | ---: |
| `/sitemap/cricbuzz-index.xml` | 15 |
| `/sitemap/cricket-news.xml` | 150 |
| `/sitemap/cricket-news-archive.xml` | 601 |
| `/sitemap/cricket-news-editorials.xml` | 5 |
| `/sitemap/cricket-photo-gallery.xml` | 10 |
| `/sitemap/cricket-videos.xml` | 587 |
| `/sitemap/cricket-player-profile.xml` | 255 |
| `/sitemap/cricket-schedule-series.xml` | 9 |
| `/sitemap/cricket-schedule-teams.xml` | 1,016 |
| `/sitemap/live-matches.xml` | 396 |
| `/sitemap/indian-premier-league-2026.xml` | 10 |
| `/sitemap/cricket-auction.xml` | 1,309 |
| **Total raw entries** | **4,363** |

The raw total is not a unique-page count. Some routes can occur in more than one sitemap, and sitemap contents can change between requests.

## Coverage signals

The inspected sitemap documents include both men's and women's cricket. Examples include:

- Women's Big Bash League match and series URLs.
- Women's international match facts and scorecards.
- Women's teams such as Namibia Women and Sierra Leone Women.
- Women's World Cup gallery pages.
- Player profile URLs for women and men.

The route mix includes matches, match facts, scorecards, squads, team pages, player profiles, news, editorials, videos, galleries, series, auctions, rankings, schedules and archives. This confirms broad public-route coverage, not that every competition or every historic match is present.

## Changes made on this branch

1. Added a dedicated sitemap-document allowlist. It accepts only HTTPS URLs on the exact `www.cricbuzz.com` host and only `/sitemap.xml` or direct `/sitemap/*.xml` documents.
2. Added recursive sitemap XML parsing. It separates child sitemap documents from page URLs, decodes XML entities, rejects external hosts and validates page URLs against the exact-host sitemap seed allowlist.
3. Added live sitemap discovery to the protected full-crawl start endpoint. It unions the latest public sitemap page URLs with the saved 8 November snapshot; it does not discard historical URLs simply because they are no longer listed today.
4. Expanded the sitemap seed allowlist to include the exact additional public page paths present in the current sitemap index (homepage, information pages, careers and the account-info landing URL). The account-info path is requested without credentials; any redirect is recorded as skipped and is not followed.
5. Added queue merging for already queued/running and paused crawl runs, with database uniqueness preventing duplicate URL jobs.
6. Added unit tests for sitemap parsing, entity decoding, sitemap-listed page paths and exact-host/HTTPS sitemap validation.
7. Increased the local worker's crawl-start request timeout to accommodate the API's 45-second live sitemap discovery budget.
8. Changed individual page redirects to be recorded as skipped without following them; source denials and throttling still stop the run.
9. Added `npm run sitemap:audit`, a local-only coverage audit that reads the live sitemap tree, compares it with the saved snapshot and prints route-family counts. It requires no Neon database or API secrets.

Sitemap requests use the provider's existing request-interval setting, request timeout and response-size limit. HTTP 401/403, 429, sitemap redirects and access challenges stop discovery. For page URLs, HTTP 401/403/429 and access challenges stop the run; individual 3xx page redirects are recorded as skipped and are not followed. No CAPTCHA, login or paywall is bypassed. Sitemap XML is discovery metadata and is not stored as a cricket entity.

## Important limits

- This audit inspected sitemap documents and their URL lists. It did not fetch the full HTML body of every listed page.
- The saved and live URL maps differ. The merge strategy preserves old URLs and adds current URLs, but a real crawl must measure 200/404/redirect/denial rates and extraction completeness.
- Sitemaps do not necessarily list every dynamically generated, JavaScript-rendered, authenticated, premium or app-only surface.
- A URL being listed does not prove that its body contains every desired statistic or that a page remains accessible.
- Generic page metadata extraction is not the same as a fully normalized match/player/team data model.
- No production crawl was started, no production authorization setting was changed, no Neon data was modified, and the ten-minute retention rule was not changed.

## Local Stage 1 audit command

From the repository root on Node.js 20 or newer:

```cmd
npm ci
npm run sitemap:audit
```

To print the full current URL list and both snapshot-difference lists as JSON:

```cmd
npm run sitemap:audit -- --full
```

The command does not connect to Neon, change production settings, enqueue crawl jobs or persist page content. It uses the same request interval and allowlist as the provider. The default minimum interval is 1,000 ms; do not change it without applying the approved source request policy.

## Acceptance checks still required

1. CI must pass on this branch, including typecheck, build and tests.
2. Review the PR and merge it to `main`.
3. Verify the production API deployment includes the merged code before starting any crawl.
4. With source authorization and worker readiness confirmed, perform a bounded source-coverage acceptance run, then review route-family counts and HTTP outcome counts before any large crawl.
5. Compare discovered URLs, queued URLs, fetched pages, extracted entities and page-level errors. A completed queue alone is not proof of complete data coverage.
6. Confirm the crawl's exported route inventory and coverage report identify missing or unsupported route families.

Stage 1 is improved by the live sitemap discovery implementation, but it is not accepted as complete until the branch passes CI and the bounded live coverage checks are reviewed.
