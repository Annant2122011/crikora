import type { CrikoraEntity, EntityRepository } from "../domain/entities.js";
import type { Match, MatchEvent } from "../domain/types.js";
import { detectMilestoneEvents } from "../engine/events.js";
import type { CricketProvider } from "../providers/provider.js";

export class Poller {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly provider: CricketProvider,
    private readonly repository: EntityRepository,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const snapshot = await this.provider.fetchSnapshot();
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
        const enrichedMatch = { ...match, events: [...uniqueEvents.values()] };

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
      this.onError(error);
      throw error;
    } finally {
      this.running = false;
    }
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
