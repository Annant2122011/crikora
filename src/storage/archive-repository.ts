import type { EntityType } from "../domain/entities.js";
import type { SourcePageCapture } from "../domain/types.js";

export interface EntityHistoryRecord {
  id: string;
  entityType: EntityType;
  sourceId: string;
  sourceUrl: string;
  payloadHash: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  observedAt: string;
}

export interface ArchiveCoverageRow {
  pageKind: string;
  status: string;
  pageCount: number;
  totalFetches: number;
  totalVersions: number;
  lastFetchedAt: string | null;
}

export interface ArchiveRepository {
  recordSourcePages(pages: SourcePageCapture[], crawlRunId?: string): Promise<{ inserted: number; duplicates: number }>;
  listEntityHistory(entityType: EntityType, sourceId: string, limit?: number, before?: string): Promise<EntityHistoryRecord[]>;
  getArchiveCoverage(): Promise<ArchiveCoverageRow[]>;
}

export function isArchiveRepository(value: unknown): value is ArchiveRepository {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArchiveRepository>;
  return typeof candidate.recordSourcePages === "function" &&
    typeof candidate.listEntityHistory === "function" &&
    typeof candidate.getArchiveCoverage === "function";
}
