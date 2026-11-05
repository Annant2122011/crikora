# Crikora

A cricket quick-score and match-moments backend. The first implementation provides a provider-neutral ingestion pipeline, deterministic event detection, an HTTP API, and a safe demo provider.

## Important source boundary

The Cricbuzz adapter is intentionally **not implemented or enabled**. The email supplied so far is signed by "Crickora Support Team", not Cricbuzz, and does not grant permission for automated collection, storage, or redistribution. Do not point this project at Cricbuzz pages or undocumented endpoints unless you have explicit written authorization from an authorized Cricbuzz representative covering those exact activities.

The provider interface is designed so an authorized, documented source can be added without changing the normalizer, event engine, storage, or API.

## Requirements

- Node.js 20+
- npm

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

Open http://localhost:8787/health and http://localhost:8787/v1/matches/live.

The demo provider returns clearly labelled synthetic fixtures. It is for development only, not live cricket data.

## Architecture

1. **Provider adapter** fetches from an authorized source (demo adapter included).
2. **Normalizer** validates and maps provider data into Crikora's stable schema.
3. **Event engine** deterministically detects boundaries, wickets, and batter milestones.
4. **Repository** stores the latest normalized snapshot and deduplicated events (in-memory development repository included).
5. **API** serves matches, scorecards, and event timelines.
6. **Poller** runs with a single-flight guard, bounded retries, graceful shutdown, and configurable cadence.

For production, replace the in-memory repository with PostgreSQL, add a durable job/queue layer, metrics/alerts, authentication and per-user preferences, and use provider-specific rate limits. Never treat a browser extension as a secure place for source credentials.

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
```

## Adding a provider

Implement `CricketProvider` in `src/providers/provider.ts`. Map only data your provider is authorized to supply. Keep network access, credentials, rate limits, and attribution requirements inside that adapter. Do not bypass access controls or use undocumented endpoints without written approval.
