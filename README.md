# Crikora

Crikora is a cricket quick-score and match-moments backend. It is designed around live, upcoming, and completed matches, concise scorecards, significant events, and a stable API for the browser extension.

## Source authorization and operating boundary

The supplied message is from `grievance@cricbuzz.com` and explicitly refers to web-scraping access and a collection-to-API workflow. That is a meaningful authorization signal. Before enabling production collection, retain the original email with full headers and get the source owner to confirm operational details that the message does not specify: approved pages/endpoints, request limits and polling cadence, permitted fields, caching/retention, attribution, correction/deletion handling, and whether public redistribution and any future monetization are covered.

**The Cricbuzz collector is not enabled in this repository yet.** No Cricbuzz URL, selector, undocumented endpoint, or polling pattern has been assumed. The source adapter must be implemented against the exact pages or interfaces Cricbuzz approves. Until then, the API runs on synthetic demo data. This avoids silently turning a vague technical assumption into a production dependency.

## Requirements

- Node.js 20+
- npm

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open:
- http://localhost:8787/health
- http://localhost:8787/v1/matches/live

The demo provider returns synthetic development fixtures, not real match data.

## Architecture

1. **Source adapter** retrieves data only from an authorized source and observes its documented limits.
2. **Normalizer** validates provider payloads and maps them into Crikora's stable domain model.
3. **Event engine** detects significant match moments. Prefer source delivery/event IDs; scorecard-delta inference is only a fallback and must be labelled as inferred.
4. **Repository** persists normalized snapshots and idempotent events.
5. **API** serves matches, scorecards, and event timelines.
6. **Poller/worker** handles single-flight polling, backoff, timeouts, stale-source detection, and graceful shutdown.

The current implementation is a development scaffold with an in-memory repository. It is not yet a production deployment. PostgreSQL persistence, durable job scheduling, source-specific parsing, metrics/alerts, API authentication, user preferences, and notification delivery remain production milestones.

## API

- `GET /health`
- `GET /v1/matches?status=live|upcoming|completed`
- `GET /v1/matches/live`
- `GET /v1/matches/:matchId`
- `GET /v1/matches/:matchId/events`

## Tests

```bash
npm test
npm run typecheck
npm run build
```

## Adding the Cricbuzz source

Read [Cricbuzz source onboarding](docs/CRICBUZZ_SOURCE_ONBOARDING.md) first. Implement the source adapter only after the approved page/API list, schema examples, rate limits, and redistribution terms are confirmed. Keep credentials on the backend, never in the browser extension. Do not bypass authentication, anti-bot controls, or other technical restrictions.
