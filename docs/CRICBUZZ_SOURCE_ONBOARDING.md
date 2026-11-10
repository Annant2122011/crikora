# Cricbuzz source integration

Keep the original permission email with full headers in a private project record. Do not commit private correspondence, cookies, credentials, or provider tokens.

The project owner reports that access has been granted. The scraper is intentionally scoped to publicly readable cricket-data HTML pages needed by the extension: matches, scores, scorecards, squads, players, teams, series, venues, news and related cricket content. It does not need Cricbuzz-issued API credentials or source-side allowlisting for these public pages, and it does not call private app endpoints.

## Email

The project documentation contains the following permission message. It is preserved verbatim as found on the current `main` branch:

> Dear Kumar Annant,
>
> I hope this message finds you well.
>
> I am writing to formally grant you permission to access our system without the typical API limits and restrictions. As your uncle, I understand your enthusiasm for coding and support your efforts in your new project. It is important that you have the tools and resources you need to explore and develop your skills.
>
> Please ensure that you understand the responsibilities that come with this access. Adhering to a respectful and ethical use of our resources is crucial.
>
> If you have any questions or require further assistance, feel free to reach out.
>
> Wishing you all the best on your project!
>
> Best regards,
>
> Satyanarayan Dev  
> Grievance Department  
> Cricbuzz  
> grievances@cricbuzz.com

**Scope:** This implementation only requests the public cricket pages listed below. It does not attempt private API, login-only, account, advertising or other unrelated routes. No source API key or source-side allowlist is configured. A page-level denial is recorded as a skipped URL; it does not stop other pages. HTTP 429 is respected with `Retry-After`, and transient server/network errors retry with backoff.

## Email
Dear Kumar Annant,

I hope this message finds you well. 

I am writing to formally grant you permission to access our system without the typical API limits and restrictions. As your uncle, I understand your enthusiasm for coding and support your efforts in your new project. It is important that you have the tools and resources you need to explore and develop your skills.

Please ensure that you understand the responsibilities that come with this access. Adhering to a respectful and ethical use of our resources is crucial.

If you have any questions or require further assistance, feel free to reach out.

Wishing you all the best on your project!

Best regards,

Satyanarayan Dev  
Grievance Department  
Cricbuzz  
grievances@cricbuzz.com

## Observed public page routes

The current public website exposes these routes:

- Live index: `https://www.cricbuzz.com/cricket-match/live-scores`
- Upcoming index: `https://www.cricbuzz.com/cricket-match/live-scores/upcoming-matches`
- Recent results index: `https://www.cricbuzz.com/cricket-match/live-scores/recent-matches`
- Match page: `/live-cricket-scores/{matchId}/{slug}`
- Match facts/info: `/cricket-match-facts/{matchId}/{slug}`
- Scorecard: `/live-cricket-scorecard/{matchId}/{slug}`
- Squads: `/cricket-match-squads/{matchId}/{slug}`
- Full commentary: `/live-cricket-full-commentary/{matchId}/{slug}`
- Player profile: `/profiles/{playerId}/{slug}`
- Team: `/cricket-team/{teamSlug}/{teamId}`
- Series: `/cricket-series/{seriesId}/{slug}`
- Venue: `/cricket-series/{seriesId}/{seriesSlug}/venues/{venueId}/{venueSlug}`

The collector discovers tab URLs from each match page's own links. It does not construct or call undocumented API/mobile endpoints.

## Collection model

- Match indexes discover live, upcoming and completed matches.
- Match pages link to facts, scorecard, squads and commentary.
- Match facts and squad pages link to player, team, series and venue records.
- Player/profile pages provide image URLs, flag images, personal details, teams, career summaries and any visible statistical tables.
- Generic player/team/series/venue extraction captures title, canonical URL, meta tags, absolute image URLs, media/poster URLs, links, labels, tables, sections, JSON-LD, interactive tab labels and bounded visible page text.
- Generic HTML metadata records also cover news articles/categories, video pages/collections/categories/playlists, galleries, rankings, schedules, archives, auctions, commentary, live graphs, match forecasts/highlights, player match performance/highlights and Wicket Zone pages.
- Match JSON preserves innings, player scorecard rows, match facts, squad extraction, images, visible commentary and normalized boundary/wicket events.
- Current route coverage and the distinction between HTML pages and app/media services are documented in `docs/CRICBUZZ_HTML_AND_NON_HTML_COVERAGE.md`.

## Retention and database

- Neon project: `crikora`, database: `crikora`, branch: `production`.
- PostgreSQL table: `public.crikora_cache`.
- Payloads are stored as JSONB with a ten-minute expiry.
- API queries never return expired rows.
- Cleanup deletes expired rows on startup and every five seconds while the service is running.
- Re-seen records are upserted and their ten-minute TTL restarts.
- The cache is not a permanent statistics archive.

Apply `migrations/001_crikora_cache.sql`, `migrations/002_crikora_crawler_settings.sql` and `migrations/003_crikora_worker_state.sql` to the Crikora project before enabling the Vercel worker. Use the pooled Neon connection string in server-only `DATABASE_URL` environment variables. Never place it in the extension bundle.

## Operational controls

Environment settings:

- `POLL_INTERVAL_SECONDS` (10, 15, 20 or 30; default 10)
- `CRIKORA_ADMIN_SECRET`
- `CRIKORA_REFRESH_SECRET`
- `CRICBUZZ_MIN_REQUEST_INTERVAL_MS` (separate from refresh cadence; default 0)
- `CRICBUZZ_MAX_MATCHES_PER_POLL`
- `CRICBUZZ_MAX_PROFILES_PER_POLL`
- `CRICBUZZ_MAX_TEAMS_PER_POLL`
- `CRICBUZZ_MAX_SERIES_PER_POLL`
- `CRICBUZZ_MAX_VENUES_PER_POLL`
- `CRICBUZZ_TIMEOUT_MS`
- `CRICBUZZ_MAX_RESPONSE_BYTES`
- `CRICBUZZ_USER_AGENT`
- Worker-only `CRIKORA_API_BASE_URL`, `CRIKORA_WORKER_ADMIN_SECRET`, `CRIKORA_ADMIN_SECRET` and `CRIKORA_REFRESH_SECRET` (see `crawler-worker/README.md`)

The refresh cadence defaults to 10 seconds and is user-selectable at 10, 15, 20 or 30 seconds. Source-request spacing is separately configurable with `CRICBUZZ_MIN_REQUEST_INTERVAL_MS`. A 401/403/404 or redirect affects only that URL and is marked skipped; 429 honors `Retry-After`; 5xx/network failures retry with bounded backoff. The collector never bypasses a challenge.

Requests are sequential and have exact-host cricket-route filters, HTTPS checks, timeouts, response-size limits and an identifying User-Agent. Page-level 401/403/404/redirect/challenge responses are skipped individually; 429 and transient 5xx are handled with backoff. No CAPTCHA bypass, cookie replay, account automation or anti-bot evasion is implemented.

## Validation

The repository includes parser tests for player, venue, team and series URL classification, profile image extraction, JSON metadata, tables and associations, plus exact ten-minute in-memory expiration and cleanup. Add saved HTML fixtures from representative authorized pages as they are verified. Typecheck, test and build must pass before deployment. The nested `crawler-worker` project has its own Nitro build; it is intended to be built and deployed as a separate Vercel project with root directory `crawler-worker`.

The current extraction covers content present in the accessible HTML and page navigation. Content rendered only after a browser-side interaction, unavailable due to access restrictions, or delivered through separate protected services is not fabricated or guessed. Image URLs are returned, not downloaded; video/audio streams are not fetched by this JSON collector.
