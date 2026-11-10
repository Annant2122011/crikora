import { Pool } from "pg";
import {
  DATA_TTL_SECONDS,
  getEntityRetentionClass,
  type CrikoraEntity,
  type EntityRepository,
  type EntityType,
  type RetentionClass,
  type StoredEntity
} from "../domain/entities.js";

interface CacheRow {
  entity_type: EntityType;
  source_id: string;
  source_url: string;
  payload: Record<string, unknown>;
  fetched_at: Date | string;
  expires_at: Date | string | null;
  retention_class: RetentionClass;
}

function hydrate(row: CacheRow): StoredEntity {
  return {
    entityType: row.entity_type,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    payload: row.payload,
    fetchedAt: new Date(row.fetched_at).toISOString(),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    retentionClass: row.retention_class
  };
}

/** PostgreSQL JSON store with per-entity volatile or persistent retention. */
export class PostgresEntityRepository implements EntityRepository {
  private readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: "crikora-api"
    });
  }

  async upsertMany(entities: CrikoraEntity[]): Promise<void> {
    if (!entities.length) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const entity of entities) {
        const fetchedAt = new Date(entity.fetchedAt);
        if (Number.isNaN(fetchedAt.getTime())) throw new Error("Entity fetchedAt must be a valid ISO timestamp.");
        const retentionClass = getEntityRetentionClass(entity);
        const expiresAt = retentionClass === "ephemeral"
          ? new Date(fetchedAt.getTime() + DATA_TTL_SECONDS * 1000).toISOString()
          : null;
        await client.query(
          `INSERT INTO public.crikora_cache
            (entity_type, source_id, source_url, payload, fetched_at, expires_at, retention_class, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz, $7, now())
           ON CONFLICT (entity_type, source_id) DO UPDATE SET
             source_url = EXCLUDED.source_url,
             payload = EXCLUDED.payload,
             fetched_at = EXCLUDED.fetched_at,
             expires_at = EXCLUDED.expires_at,
             retention_class = EXCLUDED.retention_class,
             updated_at = now()`,
          [
            entity.entityType, entity.sourceId, entity.sourceUrl,
            JSON.stringify(entity.payload), fetchedAt.toISOString(),
            expiresAt, retentionClass
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(entityType: EntityType, sourceId: string): Promise<StoredEntity | undefined> {
    const result = await this.pool.query<CacheRow>(
      `SELECT entity_type, source_id, source_url, payload, fetched_at, expires_at, retention_class
       FROM public.crikora_cache
       WHERE entity_type = $1 AND source_id = $2
         AND (expires_at IS NULL OR expires_at > now())`,
      [entityType, sourceId]
    );
    return result.rows[0] ? hydrate(result.rows[0]) : undefined;
  }

  async list(entityType: EntityType, limit = 100): Promise<StoredEntity[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.pool.query<CacheRow>(
      `SELECT entity_type, source_id, source_url, payload, fetched_at, expires_at, retention_class
       FROM public.crikora_cache
       WHERE entity_type = $1 AND (expires_at IS NULL OR expires_at > now())
       ORDER BY fetched_at DESC LIMIT $2`,
      [entityType, safeLimit]
    );
    return result.rows.map(hydrate);
  }

  async search(query: string, limit = 50): Promise<StoredEntity[]> {
    const q = query.trim();
    if (!q) return [];
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.pool.query<CacheRow>(
      `SELECT entity_type, source_id, source_url, payload, fetched_at, expires_at, retention_class
       FROM public.crikora_cache
       WHERE (expires_at IS NULL OR expires_at > now()) AND payload::text ILIKE $1
       ORDER BY fetched_at DESC LIMIT $2`,
      [`%${q.replace(/[\\%_]/g, "\\$&")}%`, safeLimit]
    );
    return result.rows.map(hydrate);
  }

  async cleanupExpired(): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM public.crikora_cache WHERE expires_at IS NOT NULL AND expires_at <= now()"
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> { await this.pool.end(); }

  /** Used by readiness checks; does not create or mutate schema. */
  async ping(): Promise<void> { await this.pool.query("SELECT 1 FROM public.crikora_cache LIMIT 0"); }
}
