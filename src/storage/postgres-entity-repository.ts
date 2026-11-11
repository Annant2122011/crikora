import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { createArchiveObjectStoreFromEnv, type ArchiveObjectStore } from "./neon-s3-archive-object-store.js";
import { Pool, type PoolClient } from "pg";
import type { SourcePageCapture } from "../domain/types.js";
import type { ArchivedSourcePage, ArchiveCoverageRow, ArchiveRepository, EntityHistoryRecord } from "./archive-repository.js";
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
  "match", "cricket-match", "match-facts", "match-scorecard", "match-squads", "commentary",
  "live-stream-page", "live-graphs", "over-by-over", "match-highlights",
  "match-forecast", "wicket-zone", "player-match-performance",
  "ranking-or-statistics", "player-stats",
  "news-index", "news-category", "video-index", "video-collection", "gallery-index",
  "player-directory", "team-directory", "schedule", "scorecard-archives"
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


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function jsonValue(value: unknown): string {
  return JSON.stringify(value ?? {});
}
function dateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const iso = value.match(/^\d{4}-\d{2}-\d{2}$/);
  if (iso) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** PostgreSQL JSON store with per-entity volatile or persistent retention. */
export class PostgresEntityRepository implements EntityRepository, ArchiveRepository {
  private readonly pool: Pool;
  private readonly archiveObjectStore?: ArchiveObjectStore;
  constructor(
    connectionString: string,
    archiveObjectStore: ArchiveObjectStore | undefined = createArchiveObjectStoreFromEnv()
  ) {
    this.archiveObjectStore = archiveObjectStore;
    if (process.env.NODE_ENV === "production" && !this.archiveObjectStore) {
      throw new Error(
        "Production historical archiving requires Neon Object Storage. Configure AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and CRIKORA_ARCHIVE_BUCKET."
      );
    }
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
      for (const entity of orderedEntities) {
        await this.persistTypedProjection(client, entity, new Date(entity.fetchedAt).toISOString());
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }


  /**
   * Keep the current typed read projections in sync with the current JSON entity
   * in the same transaction. Historical versions remain in append-only snapshots.
   */
  private async persistTypedProjection(client: PoolClient, entity: CrikoraEntity, observedAt: string): Promise<void> {
    if (entity.entityType === "player") {
      const profile = entity.payload.profile;
      if (!isRecord(profile) || Number(profile.schemaVersion) !== 1) return;
      const sourceId = entity.sourceId;
      await client.query(
        `INSERT INTO public.crikora_player_profiles
          (source_id, source_url, full_name, country, role, batting_style, bowling_style,
           birth_date, birth_place, height_cm, biography, profile_image_url, teams, profile_data,
           first_observed_at, last_observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14::jsonb,$15::timestamptz,$15::timestamptz)
         ON CONFLICT (source_id) DO UPDATE SET
           source_url=EXCLUDED.source_url, full_name=EXCLUDED.full_name, country=EXCLUDED.country,
           role=EXCLUDED.role, batting_style=EXCLUDED.batting_style, bowling_style=EXCLUDED.bowling_style,
           birth_date=EXCLUDED.birth_date, birth_place=EXCLUDED.birth_place, height_cm=EXCLUDED.height_cm,
           biography=EXCLUDED.biography, profile_image_url=EXCLUDED.profile_image_url,
           teams=EXCLUDED.teams, profile_data=EXCLUDED.profile_data, last_observed_at=EXCLUDED.last_observed_at`,
        [
          sourceId, entity.sourceUrl, nullableString(profile.fullName), nullableString(profile.country),
          nullableString(profile.role), nullableString(profile.battingStyle), nullableString(profile.bowlingStyle),
          nullableString(profile.birthDate), nullableString(profile.birthPlace), nullableNumber(profile.heightCm),
          nullableString(profile.biography), nullableString(profile.profileImageUrl),
          Array.isArray(profile.teams) ? profile.teams.filter((value): value is string => typeof value === "string") : [],
          jsonValue(profile), observedAt
        ]
      );
      await client.query("DELETE FROM public.crikora_player_profile_attributes WHERE source_id=$1", [sourceId]);
      await client.query("DELETE FROM public.crikora_player_statistics WHERE source_id=$1", [sourceId]);
      const attributes = arrayOfRecords(profile.attributes);
      for (let index = 0; index < attributes.length; index++) {
        const attribute = attributes[index]!;
        const value = attribute.value;
        const type = ["text","numeric","date","boolean","json"].includes(String(attribute.valueType))
          ? String(attribute.valueType) : "text";
        const textValue = type === "text" ? String(value ?? "") : null;
        const numericValue = type === "numeric" ? nullableNumber(typeof value === "number" ? value : Number(value)) : null;
        const dateValue = type === "date" ? dateOnly(value) : null;
        const booleanValue = type === "boolean" ? Boolean(value) : null;
        const jsonAttribute = type === "json" ? jsonValue(value) : null;
        await client.query(
          `INSERT INTO public.crikora_player_profile_attributes
            (source_id,field_path,source_label,section,value_type,value_text,value_numeric,value_date,value_boolean,value_json,ordinal,observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10::jsonb,$11,$12::timestamptz)`,
          [
            sourceId, String(attribute.fieldPath ?? "field_" + index), String(attribute.sourceLabel ?? attribute.fieldPath ?? "Field"),
            nullableString(attribute.section), type, textValue, numericValue, dateValue, booleanValue, jsonAttribute, index, observedAt
          ]
        );
      }
      for (const statistic of arrayOfRecords(profile.statistics)) {
        await client.query(
          `INSERT INTO public.crikora_player_statistics
            (source_id,table_index,row_index,section,row_label,metric_label,metric_key,source_path,value_text,value_numeric,observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)`,
          [
            sourceId, Number(statistic.tableIndex ?? 0), Number(statistic.rowIndex ?? 0),
            nullableString(statistic.section), nullableString(statistic.rowLabel),
            String(statistic.metricLabel ?? "Value"), String(statistic.metricKey ?? "value"),
            nullableString(statistic.sourcePath), String(statistic.valueText ?? ""),
            nullableNumber(statistic.valueNumeric), observedAt
          ]
        );
      }
      return;
    }

    if (entity.entityType !== "match" || !isRecord(entity.payload.matchData)) return;
    const data = entity.payload.matchData;
    const innings = arrayOfRecords(data.innings);
    const deliveries = arrayOfRecords(data.deliveries);
    const commentary = arrayOfRecords(data.commentary);
    if (!innings.length && !deliveries.length && !commentary.length) return;

    const matchId = entity.sourceId;
    for (const table of [
      "crikora_match_commentary", "crikora_match_deliveries", "crikora_match_fall_of_wickets",
      "crikora_match_partnerships", "crikora_match_bowling", "crikora_match_batting", "crikora_match_innings"
    ]) {
      await client.query(`DELETE FROM public.${table} WHERE match_source_id=$1`, [matchId]);
    }
    for (const inning of innings) {
      const number = Number(inning.inningsNumber ?? 1);
      const extras = isRecord(inning.extras) ? inning.extras : {};
      await client.query(
        `INSERT INTO public.crikora_match_innings
          (match_source_id,innings_number,team_name,runs,wickets,overs,extras_total,byes,leg_byes,wides,no_balls,penalty,raw_data,observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::timestamptz)`,
        [
          matchId, number, nullableString(inning.teamName), nullableNumber(inning.runs), nullableNumber(inning.wickets),
          nullableString(inning.overs), Number(extras.total ?? 0), Number(extras.byes ?? 0),
          Number(extras.legByes ?? 0), Number(extras.wides ?? 0), Number(extras.noBalls ?? 0),
          Number(extras.penalty ?? 0), jsonValue(inning), observedAt
        ]
      );
      const batters = arrayOfRecords(inning.batters);
      for (let index = 0; index < batters.length; index++) {
        const batter = batters[index]!;
        await client.query(
          `INSERT INTO public.crikora_match_batting
            (match_source_id,innings_number,player_source_id,player_name,dismissal,runs,balls,fours,sixes,strike_rate,not_out,batting_position,raw_data,observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::timestamptz)`,
          [
            matchId, number, nullableString(batter.playerSourceId), String(batter.playerName ?? "Unknown"),
            nullableString(batter.dismissal), Number(batter.runs ?? 0), Number(batter.balls ?? 0),
            Number(batter.fours ?? 0), Number(batter.sixes ?? 0), nullableNumber(batter.strikeRate),
            Boolean(batter.notOut), index + 1, jsonValue(batter), observedAt
          ]
        );
      }
      const bowlers = arrayOfRecords(inning.bowlers);
      for (let index = 0; index < bowlers.length; index++) {
        const bowler = bowlers[index]!;
        await client.query(
          `INSERT INTO public.crikora_match_bowling
            (match_source_id,innings_number,player_source_id,player_name,overs,maidens,runs,wickets,no_balls,wides,economy,bowling_position,raw_data,observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::timestamptz)`,
          [
            matchId, number, nullableString(bowler.playerSourceId), String(bowler.playerName ?? "Unknown"),
            String(bowler.overs ?? "0"), Number(bowler.maidens ?? 0), Number(bowler.runs ?? 0),
            Number(bowler.wickets ?? 0), Number(bowler.noBalls ?? 0), Number(bowler.wides ?? 0),
            nullableNumber(bowler.economy), index + 1, jsonValue(bowler), observedAt
          ]
        );
      }
      for (const partnership of arrayOfRecords(inning.partnerships)) {
        await client.query(
          `INSERT INTO public.crikora_match_partnerships
            (match_source_id,innings_number,partnership_number,batter_one,batter_one_source_id,batter_one_runs,batter_one_balls,
           batter_two,batter_two_source_id,batter_two_runs,batter_two_balls,runs,balls,description,observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz)`,
          [
            matchId, number, Number(partnership.partnershipNumber ?? 1), nullableString(partnership.batterOne),
            nullableString(partnership.batterOneSourceId), nullableNumber(partnership.batterOneRuns),
            nullableNumber(partnership.batterOneBalls), nullableString(partnership.batterTwo),
            nullableString(partnership.batterTwoSourceId), nullableNumber(partnership.batterTwoRuns),
            nullableNumber(partnership.batterTwoBalls), Number(partnership.runs ?? 0),
            nullableNumber(partnership.balls), nullableString(partnership.description), observedAt
          ]
        );
      }
      for (const wicket of arrayOfRecords(inning.fallOfWickets)) {
        await client.query(
          `INSERT INTO public.crikora_match_fall_of_wickets
            (match_source_id,innings_number,wicket_number,score,batter_name,player_source_id,over,description,observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`,
          [
            matchId, number, Number(wicket.wicketNumber ?? 1), nullableNumber(wicket.score),
            nullableString(wicket.batterName), nullableString(wicket.playerSourceId),
            nullableString(wicket.over), String(wicket.description ?? ""), observedAt
          ]
        );
      }
    }

    for (const delivery of deliveries) {
      await client.query(
        `INSERT INTO public.crikora_match_deliveries
          (match_source_id,source_event_id,innings_number,over_number,ball_number,
           batter,batter_source_id,non_striker,non_striker_source_id,bowler,bowler_source_id,
           bat_runs,extra_runs,total_runs,extra_type,byes,leg_byes,wides,no_balls,penalty,
           is_wicket,dismissal_type,dismissed_player,dismissed_player_source_id,fielder,fielder_source_id,
           description,commentary,event_type,raw_data,observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb,$31::timestamptz)`,
        [
          matchId, String(delivery.sourceEventId ?? "event_" + JSON.stringify(delivery)),
          Number(delivery.inningsNumber ?? 1), nullableNumber(delivery.overNumber), nullableNumber(delivery.ballNumber),
          nullableString(delivery.batter), nullableString(delivery.batterSourceId),
          nullableString(delivery.nonStriker), nullableString(delivery.nonStrikerSourceId),
          nullableString(delivery.bowler), nullableString(delivery.bowlerSourceId),
          Number(delivery.batRuns ?? 0), Number(delivery.extraRuns ?? 0), Number(delivery.totalRuns ?? 0),
          nullableString(delivery.extraType),
          Number(isRecord(delivery.extras) ? delivery.extras.byes ?? 0 : 0),
          Number(isRecord(delivery.extras) ? delivery.extras.legByes ?? 0 : 0),
          Number(isRecord(delivery.extras) ? delivery.extras.wides ?? 0 : 0),
          Number(isRecord(delivery.extras) ? delivery.extras.noBalls ?? 0 : 0),
          Number(isRecord(delivery.extras) ? delivery.extras.penalty ?? 0 : 0),
          Boolean(delivery.isWicket), nullableString(delivery.dismissalType),
          nullableString(delivery.dismissedPlayer), nullableString(delivery.dismissedPlayerSourceId),
          nullableString(delivery.fielder), nullableString(delivery.fielderSourceId),
          nullableString(delivery.description), nullableString(delivery.commentary),
          nullableString(delivery.eventType), jsonValue(delivery.rawData ?? delivery), observedAt
        ]
      );
    }
    for (const item of commentary) {
      await client.query(
        `INSERT INTO public.crikora_match_commentary
          (match_source_id,source_event_id,innings_number,over_number,ball_number,event_type,batter,bowler,description,commentary,raw_data,observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz)`,
        [
          matchId, String(item.sourceEventId ?? "comment_" + JSON.stringify(item)),
          Number(item.inningsNumber ?? 1), nullableNumber(item.overNumber), nullableNumber(item.ballNumber),
          nullableString(item.eventType), nullableString(item.batter), nullableString(item.bowler),
          nullableString(item.description), String(item.commentary ?? ""),
          jsonValue(item.rawData ?? item), observedAt
        ]
      );
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
          const objectKey = this.archiveObjectStore
            ? `pages/sha256/${contentHash.slice(0, 2)}/${contentHash}.html.gz`
            : null;
          if (objectKey && this.archiveObjectStore) {
            // Content-addressed keys make retries idempotent. A failed SQL
            // transaction can leave an unreferenced blob, but can never make
            // a committed DB row point to an upload that did not succeed.
            await this.archiveObjectStore.put(objectKey, compressed, "application/gzip");
          }
          await client.query(
            `INSERT INTO public.crikora_source_page_snapshots
              (source_url, page_kind, entity_type, source_id, content_type, content_sha256,
               body_gzip, object_key, body_bytes, stored_bytes, fetched_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
            [page.url, pageKind, page.entityType ?? null,
              page.sourceId ?? null, page.contentType || "text/html; charset=utf-8",
              contentHash, objectKey ? null : compressed, objectKey, raw.byteLength, compressed.byteLength, fetchedAt]
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

  async getSourcePageSnapshot(sourceUrl: string, requestedContentHash?: string): Promise<ArchivedSourcePage | undefined> {
    if (!validSourcePageUrl(sourceUrl)) throw new Error("Archive lookup refused a URL outside the exact Cricbuzz HTTPS host.");
    const result = await this.pool.query<{
      source_url: string;
      page_kind: string;
      entity_type: EntityType | null;
      source_id: string | null;
      content_type: string;
      content_sha256: string;
      body_gzip: Buffer | null;
      object_key: string | null;
      body_bytes: number | string;
      fetched_at: Date | string;
    }>(
      `SELECT source_url, page_kind, entity_type, source_id, content_type,
              content_sha256, body_gzip, object_key, body_bytes, fetched_at
       FROM public.crikora_source_page_snapshots
       WHERE source_url = $1 AND ($2::char(64) IS NULL OR content_sha256 = $2)
       ORDER BY id DESC
       LIMIT 1`,
      [sourceUrl, requestedContentHash ?? null]
    );
    const row = result.rows[0];
    if (!row) return undefined;

    let compressed: Uint8Array;
    if (row.object_key) {
      if (!this.archiveObjectStore) {
        throw new Error("The archived page is stored in Neon Object Storage; configure its credentials to retrieve it.");
      }
      compressed = await this.archiveObjectStore.get(row.object_key);
    } else if (row.body_gzip) {
      compressed = row.body_gzip;
    } else {
      throw new Error("The archived page metadata has no retrievable body location.");
    }

    const raw = gunzipSync(Buffer.from(compressed));
    const calculatedHash = createHash("sha256").update(raw).digest("hex");
    if (calculatedHash !== row.content_sha256.trim()) {
      throw new Error("Archived source page failed SHA-256 integrity verification.");
    }
    if (raw.byteLength !== Number(row.body_bytes)) {
      throw new Error("Archived source page failed original byte-length verification.");
    }
    return {
      sourceUrl: row.source_url,
      pageKind: row.page_kind,
      ...(row.entity_type ? { entityType: row.entity_type } : {}),
      ...(row.source_id ? { sourceId: row.source_id } : {}),
      contentType: row.content_type,
      contentHash: calculatedHash,
      fetchedAt: new Date(row.fetched_at).toISOString(),
      html: raw.toString("utf8")
    };
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
      raw_page_bytes: string | number;
      stored_bytes: string | number;
      last_fetched_at: Date | string | null;
    }>(
      `SELECT coverage.page_kind, coverage.status,
              count(*) AS page_count,
              COALESCE(sum(coverage.fetch_count), 0) AS total_fetches,
              COALESCE(sum(coverage.version_count), 0) AS raw_page_versions,
              COALESCE(sum(entity_versions.count), 0) AS entity_versions,
              COALESCE(sum(page_storage.raw_page_bytes), 0) AS raw_page_bytes,
              COALESCE(sum(page_storage.stored_bytes), 0) AS stored_bytes,
              max(coverage.last_fetched_at) AS last_fetched_at
       FROM public.crikora_archive_coverage AS coverage
       LEFT JOIN LATERAL (
         SELECT count(*) AS count
         FROM public.crikora_entity_snapshots AS snapshot
         WHERE snapshot.source_url = coverage.source_url
       ) AS entity_versions ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(body_bytes), 0) AS raw_page_bytes,
                COALESCE(sum(stored_bytes), 0) AS stored_bytes
         FROM public.crikora_source_page_snapshots AS page
         WHERE page.source_url = coverage.source_url
       ) AS page_storage ON true
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
      rawPageBytes: Number(row.raw_page_bytes),
      storedBytes: Number(row.stored_bytes),
      lastFetchedAt: row.last_fetched_at ? new Date(row.last_fetched_at).toISOString() : null
    }));
  }

  async close(): Promise<void> { await this.pool.end(); }

  /** Used by readiness checks; does not create or mutate schema. */
  async ping(): Promise<void> { await this.pool.query("SELECT 1 FROM public.crikora_cache LIMIT 0"); }
}
