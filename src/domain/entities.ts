export const ENTITY_TYPES = ["match", "player", "team", "series", "venue", "competition", "ranking", "metadata"] as const;
export type EntityType = typeof ENTITY_TYPES[number];

export interface CrikoraEntity {
  entityType: EntityType;
  sourceId: string;
  sourceUrl: string;
  payload: Record<string, unknown>;
  fetchedAt: string;
}

export interface StoredEntity extends CrikoraEntity {
  expiresAt: string;
}

export interface EntityRepository {
  upsertMany(entities: CrikoraEntity[]): Promise<void>;
  get(entityType: EntityType, sourceId: string): Promise<StoredEntity | undefined>;
  list(entityType: EntityType, limit?: number): Promise<StoredEntity[]>;
  search(query: string, limit?: number): Promise<StoredEntity[]>;
  cleanupExpired(): Promise<number>;
  close(): Promise<void>;
}

/** Every source record has a strict ten-minute lifetime. */
export const DATA_TTL_MS = 10 * 60 * 1000;
