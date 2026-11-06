import type { CrikoraEntity, EntityRepository } from "../domain/entities.js";
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

      // Keep the complete match object, including innings, stats, images and
      // normalized event timeline, as one predictable JSON resource.
      for (const match of snapshot.matches) {
        const matchEvents = snapshot.events.filter(event => event.matchId === match.id);
        const enrichedMatch = { ...match, events: match.events?.length ? match.events : matchEvents };
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
