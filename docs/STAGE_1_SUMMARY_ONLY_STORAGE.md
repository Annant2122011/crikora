# Crikora Stage 1: summary-only storage

This stage changes the storage contract. It is deliberately additive until the production data-cleanup approval and deployment window are handled.

## Permanent match record

A historical match stores only the compact match-card record:

- Stable source match ID and URL.
- Teams, competition, season, format, gender and age group.
- Start time, venue and completed result.
- Toss text, toss winner and toss decision.
- Winner and victory margin.
- Player of the match where supplied.
- Per innings: innings number, batting team, runs, wickets, overs, all-out and declared flags.

It does **not** store player-by-player batting/bowling rows, deliveries, commentary, wagon wheels, pitch maps, graphs, video assets, playing-XI detail or raw match-page HTML. The scorecard page is not read during background collection. Final innings totals are parsed only from the overview/card and essential facts page; if the source does not expose them, they remain unknown until a user opens the match. Commentary is never fetched by the background match crawler.

## Live and completed match lifecycle

- Upcoming matches are represented as match skeletons.
- Live observations update the short-lived serving cache and `crikora_live_match_state`.
- Changing live scores are not appended to permanent entity snapshots.
- When the source indicates completion, the same database transaction writes the final compact match summary and its innings totals, then deletes the transient live-state row.
- A completed summary cannot be downgraded by a delayed live/upcoming observation.
- The completed record remains in the historical match list.

## On-demand detail

The priority order for the match detail workflow is:

1. Match facts: summary/header, toss, result, venue, officials and squads when requested.
2. Scorecard: innings, batting/bowling figures, extras, dismissals, fall of wickets and partnerships.
3. Ball-by-ball commentary: retrieved only after the first two groups complete, in bounded innings/over chunks.
4. Optional extras: graphs, wagon wheels, pitch maps, forecasts, videos and other lower-priority assets.

Priority dependencies are enforced in the detail-job model/API, not left to a frontend timing accident. A match-list or live refresh must never enqueue commentary.

## Player storage

The background inventory stores only the numeric Cricbuzz player ID and canonical base profile URL in `crikora_player_urls`. It does not enqueue profile pages or career/statistics tabs. A player detail request resolves the saved URL, fetches the profile and up to 12 related statistics tabs sequentially, and returns the parsed content in the API response. The response is marked `persisted: false`; it is never written to cache, snapshots, typed projections or source-page object storage.

## News

The Cricbuzz collector refuses news URLs, news entities are filtered before persistence, and news source pages are excluded from raw-page archiving. The existing news read endpoints/data are legacy and are not cleaned up by this additive stage. A future user-owned news import is a separate ingestion path and must not share the Cricbuzz collector's news routes.

## Worldwide coverage

Stage 1 prepares the storage and lifecycle contract only. Stage 2 adds the dynamic worldwide competition registry and schedule/match skeleton discovery for international, domestic and franchise competitions, including men's, women's and youth cricket. Coverage must not be hard-coded to ICC events or to one source's top-level home page.

## Migration and cleanup

Migration `012_summary_only_match_storage.sql` creates the new read models and backfills only player ID/URL pairs and compact match summaries from eligible existing records (4 November 2026 onward). It does not delete legacy player/news/detail cache rows, append-only snapshots, typed profile records or existing object-storage files. That cleanup requires a separately authorized, exact-key deletion plan. Do not deploy the new repository code before the additive migration has been applied to the target database and verified.

## Verification boundary

Passing parser/unit tests proves the compact projection and priority policy logic only. It does not prove every competition, historical score, toss or innings total is available from the source. Missing or challenged source data must remain explicitly unknown rather than fabricated.
