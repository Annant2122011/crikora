# Stage 2: Extraction quality and crawl identity

## Delivered in this stage

### Dependency security

- Upgrade Zod to the patched 4.6.7 line. The API uses Zod directly in `src/server.ts`; removing the dependency would break request and environment validation.
- Upgrade Vitest to 5.1.0. This moves off the vulnerable Vitest 3 line and the older worker dependency chain identified by the Stage 1 audit.
- CI runs `npm audit --audit-level=moderate` after installation so a new moderate-or-higher dependency advisory fails verification.

### Stable page identity and URL alias handling

Cricbuzz URLs can use different slugs for the same underlying record. The queue now derives an identity key from the classified entity type and source ID:

- Match overview aliases use `match:<matchId>`.
- Facts, scorecard and squad pages have separate metadata identities.
- Player, team, series, venue, news, video and gallery pages use their stable source identifiers.
- Player-stat, team-subpage and series-subpage keys retain the subpage identity while ignoring the parent slug.
- Unclassified sitemap-listed pages fall back to their normalized URL.

The first URL for an identity is retained. The API orders current sitemap URLs before saved-snapshot URLs, so a current source URL wins over an old alias. The same identity key is stored in Neon and protected by a unique index per crawl run. This closes the gap where two batches could otherwise enqueue the same entity under different slugs.

Migration `005_crawl_queue_identity_keys.sql` adds the identity column, backfills existing queue rows, marks duplicate queue aliases as skipped (preferring a completed copy where available), and creates the unique index. It does not change the cache TTL or delete cached cricket data.

### Durable match-page enrichment

The durable sitemap crawler now fetches a match overview together with its related facts, scorecard, squads and commentary pages. It prefers links found on the overview page. When a tab link is absent, it tries the same match ID and slug on the corresponding public companion route.

The normalized match entity contains the extracted page payloads under `matchFacts`, `scorecardPage`, `squadPage` and `commentaryPage`, plus a `sourcePages` list. This aligns the durable crawl's match payload with the regular refresh path. Related URLs are also retained in the durable queue for their independent page records.

Companion requests are sequential and pass through the same source-response handling as ordinary pages. Missing or redirected individual pages are skipped; 401/403/429 and upstream 5xx conditions still stop or back off the crawl as already designed. The implementation does not follow redirects or bypass access challenges.

### Audit report

The local sitemap audit now reports unique page-identity counts and the number of aliases removed from the merged seed set. Under `--full`, it emits both the de-duplicated merged seed set and the original current sitemap inventory.

## Verification

Run from the repository root:

```cmd
npm install
npm audit --audit-level=moderate
npm run typecheck
npm run build
npm test
npm run sitemap:audit -- --full
```

The GitHub Actions workflow runs the dependency audit, typecheck, build and tests for the Stage 2 pull request.

## Deployment order and production safety

1. Review and merge the Stage 2 pull request after CI is green.
2. Apply migrations `001` through `005` to the existing Neon production branch in order.
3. Confirm the API and worker deployment use the existing Neon connection and credentials.
4. Keep `CRICBUZZ_AUTOMATION_AUTHORIZED=false` until deployment and acceptance checks are explicitly complete.
5. Do not start the full crawl as part of this code change.

The existing 600-second cache TTL remains unchanged. The queue stores crawl progress and identity metadata, not historical page payloads.

## Known extraction limits, not silently claimed as solved

- Commentary pages are captured as structured page data, but this stage does not claim a verified ball-by-ball event parser. The existing event heuristic remains separate and should not be treated as a complete delivery feed.
- Server-rendered HTML and embedded metadata are extracted. Content loaded only after client-side JavaScript execution may not be present in the source HTML.
- Image and media URLs are stored as references. This stage does not download image/video binaries or expose protected streams.
- A long-running crawl still uses the rolling 600-second cache. A full historical archive requires a separately approved retention/export policy.
- A package lockfile is not present on the repository's main branch. CI therefore continues to use `npm install`; do not switch it to `npm ci` until a generated and reviewed `package-lock.json` is committed.
