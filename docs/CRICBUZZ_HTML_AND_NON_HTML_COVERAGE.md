# Cricbuzz HTML and non-HTML coverage audit

**Audit date:** 8 November 2026  
**Source:** https://www.cricbuzz.com

## Scope and completeness

A sitemap-included Firecrawl URL map returned **4,721 unique URLs** on this run (maximum requested map limit: 10,000). The machine-readable URL inventory is in `docs/cricbuzz-sitemap-inventory.json`.

This is a sitemap-backed URL inventory, not proof that every possible Cricbuzz page or private endpoint is enumerated. Two attempted multi-page body crawls returned zero pages from the crawl service, so I am not representing those jobs as a completed full-site HTML body crawl. Instead, I fetched representative pages directly and verified their HTTP status, HTML bodies, links and image URL outputs. The samples below returned HTTP 200.

## Sitemap route families

Counts are from the latest map operation and will move as Cricbuzz changes its sitemap.

| URL family | URLs | Current HTML support |
|---|---:|---|
| Series, series subpages and auctions | 1,379 | Series pages, statistics, squads, points tables and auction tabs |
| Teams and team subpages | 989 | Team profiles, results and statistics tabs |
| News articles and categories | 776 | Article body, metadata, related links and images |
| Videos, collections, categories and playlists | 584 | Video metadata, links, thumbnails and posters; not the stream payload |
| Player profiles and profile tabs | 304 | Profile details, visible career tables, associations and profile images |
| Live scorecards | 189 | Scorecard pages linked from match pages |
| Match overview pages | 179 | Match cards, status, team names, links and available summary data |
| Match facts | 126 | Venue, officials, conditions and visible facts |
| Match squads | 120 | Squad/player associations |
| Sitemap XML resources | 12 | Discovery documents, not cricket records |
| Player match-performance tabs | 12 | Batting/bowling performance HTML |
| Photo galleries | 11 | Gallery index and individual gallery pages |
| Live-stream landing pages | 6 | Page metadata and links only |
| Statistics/rankings | 5 | ICC rankings and points tables |
| Match forecasts | 5 | Forecast page HTML |
| Schedule | 3 | Series and upcoming schedule HTML |
| Match highlights | 3 | Highlight page HTML and links |
| Player highlights | 3 | Player batting/bowling highlight HTML |
| Full commentary pages | 2 | Visible ball-by-ball commentary text |
| Scorecard archives | 2 | Archive index and year pages |
| Match index routes | 2 | Live/recent index pages |
| Information pages | 2 | Contact/advertising information, not cricket data |
| Wicket Zone special content | 1 | Special-content HTML |
| Live match graphs | 1 | Graph page HTML |
| Photo gallery index | 1 | Gallery navigation HTML |
| Over-by-over | 1 | Over-by-over HTML |
| Homepage, sitemap root, account page and careers | 4 | Navigation or account/corporate pages; excluded from cricket entities |

## Representative HTML pages fetched

The following representative routes were fetched with the page HTML, links and images requested. The HTML length is the returned HTML document size and is not a count of structured cricket fields.

| Page | HTTP | HTML bytes (approx.) | Image URLs returned |
|---|---:|---:|---:|
| `/cricket-match/live-scores` | 200 | 112,858 | 20+ |
| `/cricket-match/live-scores/recent-matches` | 200 | 470,308 | 20+ |
| `/cricket-news` | 200 | 67,602 | 17 |
| `/cricket-videos` | 200 | 390,033 | 20+ |
| `/cricket-videos/collection/1/latest-videos` | 200 | 92,626 | 18 |
| `/cricket-videos/categories` | 200 | 59,977 | 16 |
| `/cricket-videos/playlists` | 200 | 160,504 | 50 |
| `/cricket-photo-gallery` | 200 | 47,177 | 10 |
| `/cricket-stats` | 200 | 113,537 | 0 |
| `/cricket-stats/icc-rankings/men/batting` | 200 | 62,720 | 20+ |
| `/cricket-stats/points-table/test/icc-world-test-championship` | 200 | 63,940 | 16 |
| `/cricket-schedule/series/all` | 200 | 126,967 | 0 |
| `/cricket-scorecard-archives` | 200 | 196,428 | 0 |
| `/live-cricket-full-commentary/161256/...` | 200 | 50,301 | 2 |
| `/live-cricket-scorecard/161256/...` | 200 | 64,826 | 10 |
| `/cricket-team` | 200 | 62,999 | 20+ |
| `/cricket-series/2727/big-bash-league` | 200 | 59,026 | 7 |
| `/profiles/326/mohammad-asif` | 200 | 130,607 | 9 |

The exact full URLs and latest route samples are in the sitemap inventory and the crawler's URL-classification rules.

## What the HTML collector now covers

- Live, upcoming and recent match indexes; linked match detail pages; facts, scorecards, squads and full commentary.
- Visible batting/bowling tables, player scores, overs, wickets, extras where present, and structured page tables.
- Match venue, officials, start-time text, series/team links, and match status/summary.
- Player profile pages, personal-details fields, career-summary tables, player/team associations and visible player statistics.
- Team pages and team tabs; series pages and subpages including statistics, squads, points tables and auctions; venue pages.
- News article pages and category/index links.
- Video pages, latest-video collections, categories and playlists; visible metadata and poster/thumbnail URLs.
- Photo-gallery index and gallery pages.
- ICC rankings, points tables, schedules, scorecard archives and match forecast pages.
- Live commentary, over-by-over, live graphs, match highlights, player highlights, player match-performance tabs and Wicket Zone special pages.
- Open Graph/Twitter metadata, JSON-LD, canonical URLs, titles, headings, visible page text, tables, sections, link targets and tab/control labels.

Image references are returned as absolute HTTPS URLs, primarily on `static.cricbuzz.com`. The parser extracts `img` sources, lazy-load attributes, `srcset`, Open Graph/Twitter images, inline CSS backgrounds, `link[rel=image_src]` and video poster URLs. It does not download image binaries.

## Data that is not ordinary crawlable HTML

The following items are identified from Cricbuzz's public app listings and product descriptions. They are not interchangeable with page HTML:

1. **Live video playback.** The official App Store listing advertises live streaming for selected competitions and territories, and explicitly says availability is limited by country. The listing states it is not available in India. The crawler can extract a page's video metadata, thumbnail/poster and any media URL exposed in HTML, but it does not fetch a playback manifest, media segments, DRM licence or subscription entitlement. See the [Cricbuzz App Store listing](https://apps.apple.com/in/app/cricbuzz-live-cricket-scores/id360466413?platform=watch).
2. **Push/live match notifications.** Cricbuzz's official mobile-app page describes Smart Alerts. Notifications are app delivery events, not an HTML page dataset; the website crawler cannot reconstruct a user's notification subscription or notification stream. See [Cricbuzz mobile apps](https://www.cricbuzz.com/mobileapps).
3. **Apple Watch and notification-centre experiences.** The App Store listing describes following ball-by-ball commentary on Apple Watch and accessing scores/news/stats from Notification Center. These are native app surfaces and are not available as normal website page content. See the [App Store description](https://apps.apple.com/in/app/cricbuzz-live-cricket-scores/id360466413?platform=watch).
4. **Real-time client update transport.** Static HTML shows the current server-rendered content. Any subsequent client-side polling, fetch/XHR, Server-Sent Events or WebSocket traffic is a separate runtime network surface. This audit did not capture authenticated browser network traffic or establish a specific Cricbuzz endpoint or transport, so no undocumented endpoint is assumed.
5. **Subscription-only material and account state.** Premium editorials, protected video and user account details may require authentication, region entitlement or subscription. A public HTML page may expose a title/preview without exposing the full paid content or user's private state.
6. **Native-app APIs and device capabilities.** App notifications, widgets, watch complications and other app-to-server interactions are not page DOM. Google-indexed third-party projects describe unofficial JSON wrappers, but those do not establish Cricbuzz's official API contract or guarantee stability. They are not used by this implementation.

## Search findings used to identify non-HTML categories

- The official Cricbuzz App Store listing describes live streaming, live match notifications, premium editorials/original video and Apple Watch/Notification Center access: https://apps.apple.com/in/app/cricbuzz-live-cricket-scores/id360466413?platform=watch
- Cricbuzz's own mobile-app page describes Smart Alerts and mobile app functionality: https://www.cricbuzz.com/mobileapps
- The official Cricbuzz home page advertises streaming, live scores, commentary, highlights, videos and news: https://www.cricbuzz.com/

The search did **not** verify a documented public Cricbuzz API endpoint for the missing categories. Reverse-engineering private endpoints or bypassing a media entitlement is outside the HTML collector.

## Remaining limits

- The 4,721 URLs are sitemap-mapped; a full HTML-body crawl of all 4,721 pages was not completed in this run.
- Representative pages were fetched successfully, but dynamic client-side network responses, authenticated pages and all historical content variants were not exhaustively sampled.
- Video playback, notification feeds and app-only features are identified but not ingested.
- The parser is extensible: each newly observed route family gets a stable classifier, source ID, JSON pageKind and parser test before it is added to the production collection budget.
