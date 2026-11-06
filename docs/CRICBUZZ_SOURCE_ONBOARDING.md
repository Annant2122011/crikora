# Cricbuzz source integration

Keep the original permission email with full headers in a private project record. Do not commit private correspondence, cookies, credentials, or provider tokens.

The project owner has confirmed that the full written approval covers the Cricbuzz web-scraping workflow, data categories, and operational limits. The repository therefore implements a backend public-page collector, while all numeric request settings remain configurable so they can be copied exactly from that approval.

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
- Generic profile/team/series/venue extraction captures title, canonical URL, meta tags, image URLs, links, labels, tables, sections, JSON-LD and bounded visible page text.
- Match JSON preserves innings, player scorecard rows, match facts, squad extraction, images, visible commentary and normalized boundary/wicket events.

## Retention and database

- Neon project: `crikora`, database: `crikora`, branch: `production`.
- PostgreSQL table: `public.crikora_cache`.
- Payloads are stored as JSONB with a ten-minute expiry.
- API queries never return expired rows.
- Cleanup deletes expired rows on startup and every five seconds while the service is running.
- Re-seen records are upserted and their ten-minute TTL restarts.
- The cache is not a permanent statistics archive.

Apply `migrations/001_crikora_cache.sql` to the Crikora project before enabling PostgreSQL storage. Use the pooled Neon connection string in the backend's `DATABASE_URL` environment variable. Never place it in the extension bundle.

## Operational controls

Environment settings:

- `POLL_INTERVAL_MS`
- `CRICBUZZ_MIN_REQUEST_INTERVAL_MS`
- `CRICBUZZ_MAX_MATCHES_PER_POLL`
- `CRICBUZZ_MAX_PROFILES_PER_POLL`
- `CRICBUZZ_MAX_TEAMS_PER_POLL`
- `CRICBUZZ_MAX_SERIES_PER_POLL`
- `CRICBUZZ_MAX_VENUES_PER_POLL`
- `CRICBUZZ_TIMEOUT_MS`
- `CRICBUZZ_MAX_RESPONSE_BYTES`
- `CRICBUZZ_USER_AGENT`

The checked-in defaults are intentionally conservative placeholders. Copy the exact limits from the original approval before enabling the collector.

Requests are sequential and have host/path allowlists, HTTPS checks, timeouts, response-size limits and explicit User-Agent. HTTP 401/403/429, unexpected redirects and bot/access challenges stop the cycle. No CAPTCHA bypass, cookie replay, account automation, or anti-bot evasion is implemented.

## Validation

The repository includes parser tests for player, venue, team and series URL classification, profile image extraction, JSON metadata, tables and associations, plus exact ten-minute in-memory expiration and cleanup. Add saved HTML fixtures from representative authorized pages as they are verified. Typecheck, test and build must pass before deployment.

The current extraction covers content present in the accessible HTML and page navigation. Content rendered only after a browser-side interaction, unavailable due to access restrictions, or delivered through separate protected services is not fabricated or guessed. Image URLs are returned, not downloaded; video/audio streams are not fetched by this JSON collector.
