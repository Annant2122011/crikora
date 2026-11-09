import type { CrikoraEntity, EntityRepository } from "../domain/entities.js";
import type { Match, MatchEvent } from "../domain/types.js";
import { detectMilestoneEvents } from "../engine/events.js";
import type { CricketProvider } from "../providers/provider.js";


/**
 * Index discovery runs more frequently than deep-page enrichment. Do not let
 * a lightweight index stub erase scorecards, squads, facts, images or profile
 * links collected on a previous cycle.
 */
function mergeMatchSnapshot(previous: Match | undefined, incoming: Match): Match {
  if (!previous) return incoming;

  const mergeNonEmpty = (
    oldValues: Record<string, unknown> | undefined,
    newValues: Record<string, unknown> | undefined
  ): Record<string, unknown> => {
    const result = { ...(oldValues ?? {}) };
    for (const [key, value] of Object.entries(newValues ?? {})) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      result[key] = value;
    }
    return result;
  };

  const hasObjects = (value: Record<string, unknown> | undefined): boolean =>
    Boolean(value && Object.keys(value).length > 0);

  return {
    ...previous,
    ...incoming,
    competition: incoming.competition && incoming.competition !== "Cricket"
      ? incoming.competition
      : previous.competition,
    homeTeam: incoming.homeTeam && incoming.homeTeam !== "Unknown"
      ? incoming.homeTeam
      : previous.homeTeam,
    awayTeam: incoming.awayTeam && incoming.awayTeam !== "Unknown"
      ? incoming.awayTeam
      : previous.awayTeam,
    format: incoming.format && incoming.format !== "Unknown"
      ? incoming.format
      : previous.format,
    startTime: incoming.startTime || previous.startTime,
    venue: incoming.venue || previous.venue,
    description: incoming.description || previous.description,
    sourceUrl: incoming.sourceUrl || previous.sourceUrl,
    infoUrl: incoming.infoUrl || previous.infoUrl,
    scorecardUrl: incoming.scorecardUrl || previous.scorecardUrl,
    squadsUrl: incoming.squadsUrl || previous.squadsUrl,
    commentaryUrl: incoming.commentaryUrl || previous.commentaryUrl,
    toss: incoming.toss || previous.toss,
    result: incoming.result || previous.result,
    innings: incoming.innings?.length ? incoming.innings : previous.innings,
    images: incoming.images?.length ? incoming.images : previous.images,
    officials: hasObjects(incoming.officials)
      ? { ...(previous.officials ?? {}), ...(incoming.officials ?? {}) }
      : previous.officials,
    squads: hasObjects(incoming.squads)
      ? { ...(previous.squads ?? {}), ...(incoming.squads ?? {}) }
      : previous.squads,
    stats: mergeNonEmpty(
      previous.stats as Record<string, unknown> | undefined,
      incoming.stats as Record<string, unknown> | undefined
    ),
    events: incoming.events?.length ? incoming.events : previous.events,
    // Status and updatedAt intentionally come from the newest index/detail fetch.
    status: incoming.status,
    updatedAt: incoming.updatedAt
  };
}

function readErrorNumber(error: unknown, key: string): number | undefined {
  if (!error || typeof error !== "object" || !(key in error)) return undefined;
  const value = Number((error as unknown as Record<string, unknown>)[key]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class Poller {
  private timer?: NodeJS.Timeout;
  private running = false;
  private blockedUntilMs = 0;
  private sourceDenied = false;

  constructor(
    private readonly provider: CricketProvider,
    private readonly repository: EntityRepository,
    private intervalMs: number,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  async tick(signal?: AbortSignal): Promise<void> {
    if (this.running || this.sourceDenied || Date.now() < this.blockedUntilMs) return;
    this.running = true;
    try {
      const snapshot = await this.provider.fetchSnapshot(signal);
      const records = new Map<string, CrikoraEntity>();

      // Index-page stubs keep every discovered live/upcoming/recent match in the API.
      // Detailed records replace stubs as the rotating deep-page budget reaches them.
      for (const match of snapshot.matches) {
        const existing = await this.repository.get("match", match.sourceMatchId);
        const previousMatch = existing?.payload as unknown as Match | undefined;
        const generatedMilestones = detectMilestoneEvents(previousMatch, match);
        const oldEvents = Array.isArray(existing?.payload.events)
          ? existing.payload.events as MatchEvent[]
          : [];
        const newEvents = [
          ...(Array.isArray(match.events) ? match.events : []),
          ...snapshot.events.filter(event => event.matchId === match.id),
          ...generatedMilestones
        ];
        const uniqueEvents = new Map<string, MatchEvent>();
        for (const event of [...oldEvents, ...newEvents]) {
          uniqueEvents.set(event.sourceEventId || event.id, event);
        }
        const enrichedMatch = mergeMatchSnapshot(previousMatch, {
          ...match,
          events: [...uniqueEvents.values()]
        });

        const sourceRecord = snapshot.entities.find(entity =>
          entity.entityType === "match" && entity.sourceId === match.sourceMatchId
        );
        const record: CrikoraEntity = sourceRecord
          ? { ...sourceRecord, payload: { ...sourceRecord.payload, ...enrichedMatch }, fetchedAt: snapshot.fetchedAt }
          : {
              entityType: "match",
              sourceId: match.sourceMatchId,
              sourceUrl: match.sourceUrl ?? `https://www.cricbuzz.com/live-cricket-scores/${match.sourceMatchId}`,
              payload: enrichedMatch as unknown as Record<string, unknown>,
              fetchedAt: snapshot.fetchedAt
            };
        records.set(`match:${record.sourceId}`, record);
      }

      for (const entity of snapshot.entities) {
        const key = `${entity.entityType}:${entity.sourceId}`;
        const previous = records.get(key);
        records.set(key, previous
          ? { ...entity, payload: { ...entity.payload, ...previous.payload }, fetchedAt: snapshot.fetchedAt }
          : { ...entity, fetchedAt: snapshot.fetchedAt });
      }

      await this.repository.upsertMany([...records.values()]);
      const removed = await this.repository.cleanupExpired();
      if (removed) this.onError({ level: "info", message: "Expired Crikora cache records removed", count: removed });
    } catch (error) {
      const sourceStatus = readErrorNumber(error, "sourceStatus");
      const retryAfterMs = readErrorNumber(error, "retryAfterMs");
      if (sourceStatus === 401 || sourceStatus === 403) {
        this.sourceDenied = true;
        this.stop();
        this.onError({
          level: "error",
          sourceStatus,
          message: "Cricbuzz denied collection. Automatic polling is stopped until the source authorization is reviewed."
        });
      } else if (sourceStatus === 429) {
        const waitMs = Math.max(1_000, Math.min(3_600_000, retryAfterMs ?? 60_000));
        this.blockedUntilMs = Date.now() + waitMs;
        this.onError({
          level: "warn",
          sourceStatus,
          retryAfterMs: waitMs,
          retryAt: new Date(this.blockedUntilMs).toISOString(),
          message: "Cricbuzz throttled collection. Polling is paused until Retry-After expires."
        });
      } else if (sourceStatus !== undefined && sourceStatus >= 500) {
        this.blockedUntilMs = Date.now() + 30_000;
        this.onError({
          level: "warn",
          sourceStatus,
          retryAfterMs: 30_000,
          retryAt: new Date(this.blockedUntilMs).toISOString(),
          message: "Cricbuzz returned a server error. Polling is paused for 30 seconds."
        });
      } else {
        this.onError(error);
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  get refreshIntervalMs(): number {
    return this.intervalMs;
  }

  setRefreshIntervalSeconds(seconds: number): void {
    if (![10, 15, 20, 30].includes(seconds)) {
      throw new RangeError("Refresh interval must be one of 10, 15, 20 or 30 seconds.");
    }
    const wasRunning = Boolean(this.timer);
    if (wasRunning) this.stop();
    this.intervalMs = seconds * 1000;
    if (wasRunning) this.start();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
