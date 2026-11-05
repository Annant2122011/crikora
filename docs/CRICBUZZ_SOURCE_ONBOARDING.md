# Cricbuzz source onboarding checklist

This checklist is an engineering gate, not legal advice. Keep the original permission email and its complete headers in a private project record. Do not commit private correspondence, account credentials, cookies, or tokens.

## Authorization details to confirm

The email supplied to the project says that web-scraping access is active and describes match discovery, scorecard/event collection, normalization, change detection, database storage, and API delivery to the extension. Cricbuzz's own privacy notice and terms list grievance@cricbuzz.com as an official contact address, which supports that the address is associated with Cricbuzz; it does not independently authenticate the sender or establish the sender's authority to grant every category of licence. Preserve the original email with full headers. Before the production adapter is switched on, confirm:

- Exact approved Cricbuzz pages, routes, or documented API endpoints.
- Whether HTML page parsing, JSON interfaces, or both are permitted.
- Allowed competitions, match formats, territories, and data fields.
- Maximum request rate, minimum polling interval, concurrency, and any daily quota.
- Whether live data can be cached, how long it can be retained, and what to do with corrections or takedown requests.
- Whether normalized scores/events may be redistributed to extension users, and whether the same permission covers a public website.
- Required attribution, branding rules, and links back to Cricbuzz.
- Whether articles, editorial text, player photos, video, and highlights are excluded. The initial Crikora product should collect structured cricket data only unless each media category is separately approved.
- Permission duration, revocation process, and a technical contact for schema changes/outages.

Use the email address and sender identity as part of your verification, but do not treat the mailbox name alone as proof of the sender's authority. If any point is unclear, ask the Cricbuzz contact to confirm it in a reply.

## Implemented first-pass adapter

The repository now contains `src/providers/cricbuzz-provider.ts`. The public routes verified during implementation are:

- Live index: `https://www.cricbuzz.com/cricket-match/live-scores`
- Recent results: `https://www.cricbuzz.com/cricket-match/live-scores/recent-matches`
- Upcoming fixtures: `https://www.cricbuzz.com/cricket-match/live-scores/upcoming-matches`
- Match scorecard: `/live-cricket-scorecard/{matchId}/{slug}` (discovered from the match page's Scorecard link)
- Over-by-over page: `/live-cricket-over-by-over/{matchId}/{slug}` (available from the match page's Overs link)

The adapter currently uses the live match page for its recent delivery commentary and the discovered scorecard link for innings data. These are observed public-page routes, not a promise that Cricbuzz guarantees their HTML structure. The parser needs saved HTML fixtures and automated tests before production use.

## Technical inputs needed to finish validation

Provide sanitized examples of approved responses for:
1. Match discovery (live/upcoming/completed).
2. Match detail and innings scorecard.
3. Ball/event feed, if available.
4. Player/team/competition metadata, if in scope.

For each example, include the approved URL pattern, HTTP method, required headers (with secrets removed), pagination behavior, stable IDs, timestamps/time zones, and documented rate limits.

## Implementation requirements

- Use a backend-only source adapter. Never ship source credentials or session cookies in the extension.
- Enforce an allowlist of approved hosts and paths.
- Set explicit connect/read timeouts, bounded response sizes, and a descriptive user agent/contact.
- Respect documented rate limits; use conditional requests when supported.
- Retry only transient failures with exponential backoff and jitter. Do not retry authorization failures or rate-limit responses aggressively.
- Validate every response with a schema before persistence.
- Keep raw payload retention disabled by default unless explicitly permitted and necessary for debugging.
- Use stable source IDs for idempotency and correction handling.
- Track last successful fetch, source freshness, parse failures, and data provenance.
- Stop collection automatically on repeated authorization failures, unexpected redirects, schema drift, or an explicit kill switch.
- Do not evade CAPTCHA, bot checks, login restrictions, or other access controls.

## Activation gate

The Cricbuzz provider is implemented but must remain disabled until the exact operational limits from the written approval are copied into configuration and parser fixtures cover live, upcoming, completed, multi-innings, and representative domestic/women's pages. The demo provider remains the default. The checked-in 5-second request interval is a conservative placeholder, not a statement of Cricbuzz's approved limit.
