import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "pg";
import { ENTITY_TYPES, type EntityType, type StoredEntity } from "../src/domain/entities.js";
import { Poller } from "../src/ingestion/poller.js";
import { CricbuzzProvider } from "../src/providers/cricbuzz-provider.js";
import { PostgresEntityRepository } from "../src/storage/postgres-entity-repository.js";

type ApiRequest = IncomingMessage & { body?: unknown };
type ApiResponse = ServerResponse;

interface CrawlerSettings {
  [key: string]: any;
  refresh_interval_seconds: number;
  enabled: boolean;
  last_started_at: Date | string | null;
  last_completed_at: Date | string | null;
  lease_until: Date | string | null;
  last_error: string | null;
  updated_at: Date | string;
}

let settingsPool: Pool | undefined;
let repository: PostgresEntityRepository | undefined;
let poller: Poller | undefined;

function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not configured on this deployment.");
  return value;
}

function getPool(): Pool {
  settingsPool ??= new Pool({
    connectionString: getDatabaseUrl(),
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "crikora-vercel-api"
  });
  return settingsPool;
}

function getRepository(): PostgresEntityRepository {
  repository ??= new PostgresEntityRepository(getDatabaseUrl());
  return repository;
}

function getPoller(): Poller {
  if (!poller) {
    const provider = new CricbuzzProvider({
      minRequestIntervalMs: Number(process.env.CRICBUZZ_MIN_REQUEST_INTERVAL_MS ?? 0),
      maxMatchesPerPoll: Number(process.env.CRICBUZZ_MAX_MATCHES_PER_POLL ?? 2),
      maxProfilesPerPoll: Number(process.env.CRICBUZZ_MAX_PROFILES_PER_POLL ?? 2),
      maxTeamsPerPoll: Number(process.env.CRICBUZZ_MAX_TEAMS_PER_POLL ?? 2),
      maxSeriesPerPoll: Number(process.env.CRICBUZZ_MAX_SERIES_PER_POLL ?? 1),
      maxVenuesPerPoll: Number(process.env.CRICBUZZ_MAX_VENUES_PER_POLL ?? 1),
      timeoutMs: Number(process.env.CRICBUZZ_TIMEOUT_MS ?? 15_000),
      maxResponseBytes: Number(process.env.CRICBUZZ_MAX_RESPONSE_BYTES ?? 8_000_000),
      userAgent: process.env.CRICBUZZ_USER_AGENT ??
        "Crikora/0.1 (+https://github.com/Annant2122011/crikora)"
    });
    poller = new Poller(provider, getRepository(), 10_000);
  }
  return poller;
}

function sendJson(response: ApiResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(data));
}

function safeEqual(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(request: ApiRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  return header.match(/^Bearer\s+(.+)$/i)?.[1];
}

async function readJsonBody(request: ApiRequest): Promise<Record<string, unknown>> {
  if (request.body !== undefined) {
    const value = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    throw new TypeError("Request body must be a JSON object.");
  }

  let raw = "";
  for await (const chunk of request) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (raw.length > 16_384) throw new RangeError("Request body is too large.");
  }
  if (!raw.trim()) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function present(row: StoredEntity): Record<string, unknown> {
  return {
    ...row.payload,
    id: row.sourceId,
    entityType: row.entityType,
    sourceUrl: row.sourceUrl,
    fetchedAt: row.fetchedAt,
    expiresAt: row.expiresAt,
    ttlSeconds: 600
  };
}

function parseLimit(value: string | null, fallback: number, maximum: number): number | undefined {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) return undefined;
  return parsed;
}

async function getSettings(): Promise<CrawlerSettings> {
  const result = await getPool().query<CrawlerSettings>(
    `SELECT refresh_interval_seconds, enabled, last_started_at, last_completed_at,
            lease_until, last_error, updated_at
       FROM public.crikora_crawler_settings
      WHERE id = 1`
  );
  const row = result.rows[0];
  if (!row) throw new Error("Crikora crawler settings row is missing. Apply migration 002.");
  return row;
}

async function health(response: ApiResponse): Promise<void> {
  try {
    await getRepository().ping();
    const settings = await getSettings();
    sendJson(response, 200, {
      ok: true,
      service: "crikora-crawler-api",
      source: "cricbuzz",
      storage: "postgres",
      retentionSeconds: 600,
      refreshIntervalSeconds: settings.refresh_interval_seconds,
      enabled: settings.enabled,
      automationAuthorized: process.env.CRICBUZZ_AUTOMATION_AUTHORIZED === "true",
      lastStartedAt: settings.last_started_at,
      lastCompletedAt: settings.last_completed_at,
      lastError: settings.last_error
    });
  } catch (error) {
    sendJson(response, 503, {
      ok: false,
      service: "crikora-crawler-api",
      error: error instanceof Error ? error.message : "Storage unavailable"
    });
  }
}

async function updateSettings(request: ApiRequest, response: ApiResponse): Promise<void> {
  const expected = process.env.CRIKORA_ADMIN_SECRET;
  if (!expected) {
    sendJson(response, 503, { error: "CRIKORA_ADMIN_SECRET is not configured." });
    return;
  }
  if (!safeEqual(bearer(request), expected)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  const body = await readJsonBody(request);
  const allowedIntervals = [10, 15, 20, 30];
  const interval = body.refreshIntervalSeconds === undefined
    ? undefined
    : Number(body.refreshIntervalSeconds);

  if (body.refreshIntervalSeconds !== undefined &&
      (!Number.isInteger(interval) || !allowedIntervals.includes(interval as number))) {
    sendJson(response, 400, { error: "refreshIntervalSeconds must be 10, 15, 20 or 30." });
    return;
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    sendJson(response, 400, { error: "enabled must be a boolean." });
    return;
  }
  if (body.enabled === true && process.env.CRICBUZZ_AUTOMATION_AUTHORIZED !== "true") {
    sendJson(response, 403, {
      error: "The Cricbuzz collector is not marked as authorized in the server environment."
    });
    return;
  }

  const updated = await getPool().query<CrawlerSettings>(
    `UPDATE public.crikora_crawler_settings
        SET refresh_interval_seconds = COALESCE($1, refresh_interval_seconds),
            enabled = COALESCE($2, enabled),
            last_started_at = CASE WHEN $1::integer IS NOT NULL THEN NULL ELSE last_started_at END,
            lease_until = CASE WHEN $1::integer IS NOT NULL THEN NULL ELSE lease_until END,
            updated_at = now()
      WHERE id = 1
      RETURNING refresh_interval_seconds, enabled, last_started_at, last_completed_at,
                lease_until, last_error, updated_at`,
    [interval ?? null, body.enabled ?? null]
  );
  const settings = updated.rows[0];
  sendJson(response, 200, {
    data: {
      refreshIntervalSeconds: settings?.refresh_interval_seconds,
      enabled: settings?.enabled,
      lastStartedAt: settings?.last_started_at,
      lastCompletedAt: settings?.last_completed_at,
      updatedAt: settings?.updated_at
    },
    meta: { availableIntervalsSeconds: allowedIntervals }
  });
}

async function refresh(request: ApiRequest, response: ApiResponse): Promise<void> {
  const expected = process.env.CRIKORA_REFRESH_SECRET;
  if (!expected) {
    sendJson(response, 503, { error: "CRIKORA_REFRESH_SECRET is not configured." });
    return;
  }
  if (!safeEqual(bearer(request), expected)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }
  if (process.env.CRICBUZZ_AUTOMATION_AUTHORIZED !== "true") {
    sendJson(response, 403, { error: "Cricbuzz automation is not enabled in the server environment." });
    return;
  }

  const pool = getPool();
  const settings = await getSettings();
  if (!settings.enabled) {
    sendJson(response, 409, { error: "The crawler is currently disabled." });
    return;
  }

  // Atomic database gate serializes invocations across independent Vercel instances.
  const claim = await pool.query<{ refresh_interval_seconds: number; last_started_at: Date | string }>(
    `UPDATE public.crikora_crawler_settings
        SET last_started_at = now(),
            lease_until = now() + interval '90 seconds',
            last_error = NULL,
            updated_at = now()
      WHERE id = 1
        AND enabled = true
        AND (lease_until IS NULL OR lease_until <= now())
        AND (last_started_at IS NULL OR
             last_started_at <= now() - make_interval(secs => refresh_interval_seconds))
      RETURNING refresh_interval_seconds, last_started_at`
  );

  if (!claim.rows[0]) {
    const latest = await getSettings();
    const now = Date.now();
    const leaseUntil = latest.lease_until ? new Date(latest.lease_until).getTime() : 0;
    const nextAllowed = latest.last_started_at
      ? new Date(latest.last_started_at).getTime() + latest.refresh_interval_seconds * 1000
      : now;
    const retryAfter = Math.max(1, Math.ceil((Math.max(leaseUntil, nextAllowed) - now) / 1000));
    response.setHeader("retry-after", String(retryAfter));
    sendJson(response, 429, {
      error: "Refresh interval has not elapsed or another refresh is still running.",
      retryAfterSeconds: retryAfter
    });
    return;
  }

  try {
    await getPoller().tick();
    await pool.query(
      `UPDATE public.crikora_crawler_settings
          SET last_completed_at = now(), lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = 1`
    );
    sendJson(response, 200, {
      ok: true,
      status: "completed",
      refreshIntervalSeconds: claim.rows[0].refresh_interval_seconds,
      fetchedAt: new Date().toISOString(),
      retentionSeconds: 600,
      images: "URLs"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown collection error";
    await pool.query(
      `UPDATE public.crikora_crawler_settings
          SET lease_until = NULL, last_error = $1, updated_at = now()
        WHERE id = 1`,
      [message]
    );
    sendJson(response, 502, { ok: false, error: "Cricbuzz collection failed.", details: message });
  }
}

async function listMatches(url: URL, response: ApiResponse): Promise<void> {
  const limit = parseLimit(url.searchParams.get("limit"), 100, 500);
  const status = url.searchParams.get("status");
  if (limit === undefined || (status && !["live", "upcoming", "completed"].includes(status))) {
    sendJson(response, 400, { error: "Invalid match query." });
    return;
  }
  const rows = await getRepository().list("match", limit);
  const data = rows.filter(row => !status || row.payload.status === status).map(present);
  sendJson(response, 200, { data, meta: { count: data.length, retentionSeconds: 600, source: "cricbuzz" } });
}

async function getMatch(matchId: string, response: ApiResponse, eventsOnly = false): Promise<void> {
  const row = await getRepository().get("match", matchId.replace(/^cricbuzz:/, ""));
  if (!row) {
    sendJson(response, 404, { error: "Match not found or expired." });
    return;
  }
  if (eventsOnly) {
    sendJson(response, 200, {
      data: Array.isArray(row.payload.events) ? row.payload.events : [],
      meta: { retentionSeconds: 600 }
    });
    return;
  }
  sendJson(response, 200, { data: present(row), meta: { retentionSeconds: 600, source: "cricbuzz" } });
}

function validEntityType(value: string | undefined): EntityType | undefined {
  return ENTITY_TYPES.find(type => type === value);
}

async function listEntities(type: EntityType, url: URL, response: ApiResponse): Promise<void> {
  const limit = parseLimit(url.searchParams.get("limit"), 100, 500);
  if (limit === undefined) {
    sendJson(response, 400, { error: "Invalid limit." });
    return;
  }
  const rows = await getRepository().list(type, limit);
  sendJson(response, 200, { data: rows.map(present), meta: { count: rows.length, retentionSeconds: 600 } });
}

async function getEntity(type: EntityType, sourceId: string, response: ApiResponse): Promise<void> {
  const row = await getRepository().get(type, sourceId);
  if (!row) {
    sendJson(response, 404, { error: "Entity not found or expired." });
    return;
  }
  sendJson(response, 200, { data: present(row), meta: { retentionSeconds: 600 } });
}

async function search(url: URL, response: ApiResponse): Promise<void> {
  const query = url.searchParams.get("q")?.trim() ?? "";
  const limit = parseLimit(url.searchParams.get("limit"), 30, 100);
  if (!query || query.length > 120 || limit === undefined) {
    sendJson(response, 400, { error: "Supply q (max 120 characters) and an optional valid limit." });
    return;
  }
  const rows = await getRepository().search(query, limit);
  sendJson(response, 200, { data: rows.map(present), meta: { count: rows.length, retentionSeconds: 600 } });
}

async function route(request: ApiRequest, response: ApiResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "https://crikora.invalid");
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const method = (request.method ?? "GET").toUpperCase();

  if (path === "health" && method === "GET") return health(response);
  if (path === "settings" && method === "GET") {
    const settings = await getSettings();
    sendJson(response, 200, {
      data: {
        refreshIntervalSeconds: settings.refresh_interval_seconds,
        enabled: settings.enabled,
        lastStartedAt: settings.last_started_at,
        lastCompletedAt: settings.last_completed_at,
        lastError: settings.last_error,
        updatedAt: settings.updated_at
      },
      meta: { availableIntervalsSeconds: [10, 15, 20, 30] }
    });
    return;
  }
  if (path === "settings" && method === "PUT") return updateSettings(request, response);
  if (path === "refresh" && method === "POST") return refresh(request, response);

  if (parts[0] !== "v1") {
    sendJson(response, 404, { error: "Route not found." });
    return;
  }
  if (parts[1] === "matches" && parts.length === 2 && method === "GET") {
    return listMatches(url, response);
  }
  if (parts[1] === "matches" && parts.length === 3 && method === "GET") {
    return getMatch(parts[2]!, response);
  }
  if (parts[1] === "matches" && parts.length === 4 && parts[3] === "events" && method === "GET") {
    return getMatch(parts[2]!, response, true);
  }
  if (parts[1] === "entities" && parts.length === 3 && method === "GET") {
    const type = validEntityType(parts[2]);
    if (!type) {
      sendJson(response, 400, { error: "Unsupported entity type." });
      return;
    }
    return listEntities(type, url, response);
  }
  if (parts[1] === "entities" && parts.length === 4 && method === "GET") {
    const type = validEntityType(parts[2]);
    if (!type) {
      sendJson(response, 400, { error: "Unsupported entity type." });
      return;
    }
    return getEntity(type, parts[3]!, response);
  }
  if (parts[1] === "search" && parts.length === 2 && method === "GET") {
    return search(url, response);
  }
  if (parts.length === 2 && method === "GET") {
    const aliases: Record<string, EntityType> = {
      players: "player", teams: "team", series: "series", venues: "venue"
    };
    const type = aliases[parts[1]!];
    if (type) return listEntities(type, url, response);
  }
  if (parts.length === 3 && method === "GET") {
    const aliases: Record<string, EntityType> = {
      players: "player", teams: "team", series: "series", venues: "venue"
    };
    const type = aliases[parts[1]!];
    if (type) return getEntity(type, parts[2]!, response);
  }
  sendJson(response, 404, { error: "Route not found." });
}

export default async function handler(request: ApiRequest, response: ApiResponse): Promise<void> {
  try {
    await route(request, response);
  } catch (error) {
    console.error("Crikora Vercel API request failed", error);
    if (!response.headersSent) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Internal server error."
      });
    } else {
      response.end();
    }
  }
}
