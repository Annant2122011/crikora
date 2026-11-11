import type { CrikoraEntity, EntityRepository, EntityType, StoredEntity } from "../domain/entities.js";
import { DATA_TTL_MS, getEntityRetentionClass } from "../domain/entities.js";

/** Local/demo cache. It follows the same classified-retention contract as PostgreSQL. */
export class MemoryEntityRepository implements EntityRepository {
  private readonly rows = new Map<string, StoredEntity>();
  private key(type: EntityType, id: string): string { return `${type}:${id}`; }

  async upsertMany(entities: CrikoraEntity[]): Promise<void> {
    const now = Date.now();
    for (const entity of entities) {
      const fetchedAt = new Date(entity.fetchedAt);
      if (Number.isNaN(fetchedAt.getTime())) throw new Error("Entity fetchedAt must be a valid ISO timestamp.");
      const retentionClass = getEntityRetentionClass(entity);
      const expiry = retentionClass === "ephemeral" ? fetchedAt.getTime() + DATA_TTL_MS : null;
      this.rows.set(this.key(entity.entityType, entity.sourceId), {
        ...structuredClone(entity),
        retentionClass,
        expiresAt: expiry === null ? null : new Date(expiry).toISOString()
      });
    }
    this.prune(now);
  }

  async get(entityType: EntityType, sourceId: string): Promise<StoredEntity | undefined> {
    this.prune(Date.now());
    const row = this.rows.get(this.key(entityType, sourceId));
    return row ? structuredClone(row) : undefined;
  }

  async list(entityType: EntityType, limit = 100, offset = 0): Promise<StoredEntity[]> {
    this.prune(Date.now());
    const safeOffset = Math.max(0, Math.min(1_000_000, Math.trunc(offset)));
    return [...this.rows.values()].filter(row => row.entityType === entityType)
      .sort((a,b) => b.fetchedAt.localeCompare(a.fetchedAt))
      .slice(safeOffset, safeOffset + Math.max(1, Math.min(500, limit)))
      .map(row => structuredClone(row));
  }

  async search(query: string, limit = 50): Promise<StoredEntity[]> {
    this.prune(Date.now());
    const term = query.toLowerCase();
    return [...this.rows.values()].filter(row => JSON.stringify(row.payload).toLowerCase().includes(term))
      .slice(0, Math.max(1, Math.min(100, limit))).map(row => structuredClone(row));
  }

  async cleanupExpired(): Promise<number> { return this.prune(Date.now()); }
  async close(): Promise<void> { this.rows.clear(); }

  private prune(now: number): number {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.expiresAt !== null && new Date(row.expiresAt).getTime() <= now) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
