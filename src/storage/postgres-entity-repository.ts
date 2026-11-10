import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Pool } from "pg";
import type { SourcePageCapture } from "../domain/types.js";
import type { ArchiveCoverageRow, ArchiveRepository, EntityHistoryRecord } from "./archive-repository.js";
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if ([
      "fetchedAt", "updatedAt", "fetched_at", "updated_at", "observedAt",
      "occurredAt", "responseLastUpdated", "responseUpdatedAt", "lastUpdatedAt"
    ].includes(key)) continue;
    output[key] = stableValue(record[key]);
  }
  return output;
}

const RAW_PAGE_MIN_INTERVAL_MS = 60 * 60 * 1000;
const HIGH_CHURN_PAGE_KINDS = new Set([
  "match", "match-facts", "match-scorecard", "match-squads", "commentary",
  "live-stream-page", "live-graphs", "over-by-over", "match-highlights",
  "match-forecast", "wicket-zone", "player-match-performance",
  "ranking-or-statistics", "player-stats"
]);

export function hashEntityPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex");
}

function validSourcePageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.cricbuzz.com" &&
      !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function toIso(value: Date | string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Archive timestamp must be a valid date.");
  return date.toISOString();
}

/** PostgreSQL JSON store with per-entity volatile or persistent retention. */
export class PostgresEntityRepository implements EntityRepository, ArchiveRepository {
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
      const orderedEntities = [...entities].sort((left, right) => `${left.entityType}:${left.sourceId}`.localeCompare(`${right.entityType}:${right.sourceId}`));
      for (const entity of orderedEntities) {
        const fetchedAt = new Date(entity.fetchedAt);
        if (Number.isNaN(fetchedAt.getTime())) throw new Error("Entity fetchedAt must be a valid ISO timestamp.");
        const retentionClass = getEntityRetentionClass(entity);
        const expiresAt = retentionClass === "ephemeral"
          ? new Date(fetchedAt.getTime() + DATA_TTL_SECONDS * 1000).toISOString()
          : null;
        const payloadHash = hashEntityPayload(entity.payload);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`entity:${entity.entityType}:${entity.sourceId}`]
        );
        const latestSnapshot = await client.query<{ payload_hash: string }>(
          `SELECT payload_hash FROM public.crikora_entity_snapshots
           WHERE entity_type = $1 AND source_id = $2
           ORDER BY id DESC LIMIT 1`,
          [entity.entityType, entity.sourceId]
        );
        if (latestSnapshot.rows[0]?.payload_hash.trim() !== payloadHash) {
          await client.query(
            `INSERT INTO public.crikora_entity_snapshots
              (entity_type, source_id, source_url, payload_hash, schema_version, payload, observed_at)
             VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6::timestamptz)`,
            [entity.entityType, entity.sourceId, entity.sourceUrl, payloadHash, JSON.stringify(entity.payload), fetchedAt.toISOString()]
          );
        }
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


  async recordSourcePages(pages: SourcePageCapture[]): Promise<{ inserted: number; duplicates: number; deferred: number }> {
    if (!pages.length) return { inserted: 0, duplicates: 0, deferred: 0 };
    const client = await this.pool.connect();
    let inserted = 0;
    let duplicates = 0;
    let deferred = 0;
    try {
      await client.query("BEGIN");
      const orderedPages = [...pages].sort((left, right) => left.url.localeCompare(right.url));
      for (const page of orderedPages) {
        if (!validSourcePageUrl(page.url)) throw new Error("Archive refused a source page outside the exact Cricbuzz HTTPS host.");
        const fetchedAt = toIso(page.fetchedAt);
        const raw = Buffer.from(page.html, "utf8");
        const contentHash = createHash("sha256").update(raw).digest("hex");
        const compressed = gzipSync(raw);
        const pageKind = (page.pageKind || "unknown").slice(0, 120);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`archive-page:${page.url}`]
        );
        const latestPage = await client.query<{ content_sha256: string; fetched_at: Date | string }>(
          `SELECT content_sha256, fetched_at FROM public.crikora_source_page_snapshots
           WHERE source_url = $1
           ORDER BY fetched_at DESC, id DESC LIMIT 1`,
          [page.url]
        );
        const previousPage = latestPage.rows[0];
        const contentChanged = previousPage?.content_sha256.trim() !== contentHash;
        const previousCapturedAt = previousPage ? new Date(previousPage.fetched_at).getTime() : 0;
        const rawCaptureThrottled = contentChanged &&
          HIGH_CHURN_PAGE_KINDS.has(pageKind) &&
          previousCapturedAt > 0 &&
          new Date(fetchedAt).getTime() - previousCapturedAt < RAW_PAGE_MIN_INTERVAL_MS;
        const wasInserted = contentChanged && !rawCaptureThrottled;
        if (rawCaptureThrottled) deferred += 1;
        if (wasInserted) {
          await client.query(
            `INSERT INTO public.crikora_source_page_snapshots
              (source_url, page_kind, entity_type, source_id, content_type, content_sha256, body_gzip, body_bytes, fetched_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
            [page.url, pageKind, page.entityType ?? null, page.sourceId ?? null,
              page.contentType || "text/html; charset=utf-8", contentHash, compressed, raw.byteLength, fetchedAt]
          );
        }
        if (wasInserted) inserted += 1;
        else if (!rawCaptureThrottled) duplicates += 1;
        await client.query(
          `INSERT INTO public.crikora_archive_coverage
            (source_url, identity_key, page_kind, status, last_attempted_at, last_fetched_at,
             last_http_status, last_content_sha256, fetch_count, version_count, attempt_count, updated_at)
           VALUES ($1, $2, $3, 'captured', $4::timestamptz, $4::timestamptz, 200, $5, 1, $6, 1, now())
           ON CONFLICT (source_url) DO UPDATE SET
             identity_key = EXCLUDED.identity_key,
             page_kind = EXCLUDED.page_kind,
             status = 'captured',
             last_attempted_at = EXCLUDED.last_attempted_at,
             last_fetched_at = EXCLUDED.last_fetched_at,
             last_http_status = 200,
             last_content_sha256 = EXCLUDED.last_content_sha256,
             fetch_count = public.crikora_archive_coverage.fetch_count + 1,
             version_count = public.crikora_archive_coverage.version_count + EXCLUDED.version_count,
             attempt_count = public.crikora_archive_coverage.attempt_count + 1,
             last_error = NULL,
             updated_at = now()`,
          [page.url, page.entityType && page.sourceId ? `${page.entityType}:${page.sourceId}` : `url:${page.url}`,
            pageKind, fetchedAt, contentHash, wasInserted ? 1 : 0]
        );
      }
      await client.query("COMMIT");
      return { inserted, duplicates, deferred };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listEntityHistory(entityType: EntityType, sourceId: string, limit = 50, before?: string): Promise<EntityHistoryRecord[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const cursorId = before && /^[0-9]+$/.test(before) ? before : null;
    const result = await this.pool.query<{
      id: string | number;
      entity_type: EntityType;
      source_id: string;
      source_url: string;
      payload_hash: string;
      schema_version: number;
      payload: Record<string, unknown>;
      observed_at: Date | string;
    }>(
      `SELECT id, entity_type, source_id, source_url, payload_hash, schema_version, payload, observed_at
       FROM public.crikora_entity_snapshots
       WHERE entity_type = $1 AND source_id = $2
         AND ($4::bigint IS NULL OR id < $4::bigint)
       ORDER BY id DESC
       LIMIT $3`,
      [entityType, sourceId, safeLimit, cursorId]
    );
    return result.rows.map(row => ({
      id: String(row.id),
      entityType: row.entity_type,
      sourceId: row.source_id,
      sourceUrl: row.source_url,
      payloadHash: row.payload_hash.trim(),
      schemaVersion: row.schema_version,
      payload: row.payload,
      observedAt: new Date(row.observed_at).toISOString()
    }));
  }

  async listArchivedEntities(entityType: EntityType, limit = 50, before?: string): Promise<EntityHistoryRecord[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const cursorId = before && /^[0-9]+$/.test(before) ? before : null;
    const result = await this.pool.query<{
      id: string | number;
      entity_type: EntityType;
      source_id: string;
      source_url: string;
      payload_hash: string;
      schema_version: number;
      payload: Record<string, unknown>;
      observed_at: Date | string;
    }>(
      `WITH latest_per_entity AS (
         SELECT DISTINCT ON (source_id)
           id, entity_type, source_id, source_url, payload_hash, schema_version, payload, observed_at
         FROM public.crikora_entity_snapshots
         WHERE entity_type = $1
         ORDER BY source_id, id DESC
       )
       SELECT id, entity_type, source_id, source_url, payload_hash, schema_version, payload, observed_at
       FROM latest_per_entity
       WHERE ($3::bigint IS NULL OR id < $3::bigint)
       ORDER BY id DESC
       LIMIT $2`,
      [entityType, safeLimit, cursorId]
    );
    return result.rows.map(row => ({
      id: String(row.id),
      entityType: row.entity_type,
      sourceId: row.source_id,
      sourceUrl: row.source_url,
      payloadHash: row.payload_hash.trim(),
      schemaVersion: row.schema_version,
      payload: row.payload,
      observedAt: new Date(row.observed_at).toISOString()
    }));
  }

  async listRelatedEntityPages(entityType: EntityType, sourceId: string, limit = 100): Promise<EntityHistoryRecord[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const result = await this.pool.query<{
      id: string | number;
      entity_type: EntityType;
      source_id: string;
      source_url: string;
      payload_hash: string;
      schema_version: number;
      payload: Record<string, unknown>;
      observed_at: Date | string;
    }>(
      `WITH latest_per_page AS (
         SELECT DISTINCT ON (source_id)
           id, entity_type, source_id, source_url, payload_hash, schema_version, payload, observed_at
         FROM public.crikora_entity_snapshots
         WHERE entity_type = 'metadata'
           AND payload->>'relatedEntityType' = $1
           AND payload->>'relatedSourceId' = $2
         ORDER BY source_id, id DESC
       )
       SELECT id, entity_type, source_id, source_url, payload_hash, schema_version, payload, observed_at
       FROM latest_per_page
       ORDER BY observed_at DESC, id DESC
       LIMIT $3`,
      [entityType, sourceId, safeLimit]
    );
    return result.rows.map(row => ({
      id: String(row.id),
      entityType: row.entity_type,
      sourceId: row.source_id,
      sourceUrl: row.source_url,
      payloadHash: row.payload_hash.trim(),
      schemaVersion: row.schema_version,
      payload: row.payload,
      observedAt: new Date(row.observed_at).toISOString()
    }));
  }

  async getArchiveCoverage(): Promise<ArchiveCoverageRow[]> {
    const result = await this.pool.query<{
      page_kind: string;
      status: string;
      page_count: string | number;
      total_fetches: string | number;
      raw_page_versions: string | number;
      entity_versions: string | number;
      last_fetched_at: Date | string | null;
    }>(
      `SELECT coverage.page_kind, coverage.status,
              count(*) AS page_count,
              COALESCE(sum(coverage.fetch_count), 0) AS total_fetches,
              COALESCE(sum(coverage.version_count), 0) AS raw_page_versions,
              COALESCE(sum(entity_versions.count), 0) AS entity_versions,
              max(coverage.last_fetched_at) AS last_fetched_at
       FROM public.crikora_archive_coverage AS coverage
       LEFT JOIN LATERAL (
         SELECT count(*) AS count
         FROM public.crikora_entity_snapshots AS snapshot
         WHERE snapshot.source_url = coverage.source_url
       ) AS entity_versions ON true
       GROUP BY coverage.page_kind, coverage.status
       ORDER BY coverage.page_kind, coverage.status`
    );
    return result.rows.map(row => ({
      pageKind: row.page_kind,
      status: row.status,
      pageCount: Number(row.page_count),
      totalFetches: Number(row.total_fetches),
      rawPageVersions: Number(row.raw_page_versions),
      entityVersions: Number(row.entity_versions),
      lastFetchedAt: row.last_fetched_at ? new Date(row.last_fetched_at).toISOString() : null
    }));
  }

  async close(): Promise<void> { await this.pool.end(); }

  /** Used by readiness checks; does not create or mutate schema. */
  async ping(): Promise<void> { await this.pool.query("SELECT 1 FROM public.crikora_cache LIMIT 0"); }
}
