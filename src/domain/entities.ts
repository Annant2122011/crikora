export const ENTITY_TYPES = ["match", "player", "team", "series", "venue", "competition", "ranking", "metadata"] as const;
export type EntityType = typeof ENTITY_TYPES[number];
export type RetentionClass = "ephemeral" | "persistent";

export interface CrikoraEntity {
  entityType: EntityType;
  sourceId: string;
  sourceUrl: string;
  payload: Record<string, unknown>;
  fetchedAt: string;
}

export interface StoredEntity extends CrikoraEntity {
  expiresAt: string | null;
  retentionClass: RetentionClass;
}

export interface EntityRepository {
  upsertMany(entities: CrikoraEntity[]): Promise<void>;
  get(entityType: EntityType, sourceId: string): Promise<StoredEntity | undefined>;
  list(entityType: EntityType, limit?: number, offset?: number): Promise<StoredEntity[]>;
  search(query: string, limit?: number): Promise<StoredEntity[]>;
  cleanupExpired(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Volatile match and live-analysis data is a ten-minute cache. Stable cricket
 * records remain available until the same source identity is refreshed.
 */
export const DATA_TTL_SECONDS = 600;
export const DATA_TTL_MS = DATA_TTL_SECONDS * 1000;

export const RETENTION_POLICY = {
  ephemeralSeconds: DATA_TTL_SECONDS,
  persistent: "retained-until-refreshed"
} as const;

const EPHEMERAL_METADATA_KINDS = new Set([
  "player-stats",
  "ranking-or-statistics",
  "match-scorecard",
  "commentary",
  "live-stream-page",
  "live-graphs",
  "over-by-over",
  "player-match-performance",
  "match-forecast",
  "wicket-zone"
]);

export function getEntityRetentionClass(
  entity: Pick<CrikoraEntity, "entityType" | "payload">
): RetentionClass {
  if (entity.entityType === "match") {
    return entity.payload.status === "upcoming" || entity.payload.status === "completed" ? "persistent" : "ephemeral";
  }
  if (entity.entityType === "ranking") return "ephemeral";
  if (entity.entityType === "metadata") {
    const pageKind = entity.payload.pageKind;
    if (typeof pageKind === "string" && EPHEMERAL_METADATA_KINDS.has(pageKind)) {
      return "ephemeral";
    }
  }
  return "persistent";
}
