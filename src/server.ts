import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { z } from "zod";
import { DemoProvider } from "./providers/demo-provider.js";
import { CricbuzzProvider } from "./providers/cricbuzz-provider.js";
import { ENTITY_TYPES, type EntityRepository, type StoredEntity } from "./domain/entities.js";
import { MemoryEntityRepository } from "./storage/memory-entity-repository.js";
import { PostgresEntityRepository } from "./storage/postgres-entity-repository.js";
import { Poller } from "./ingestion/poller.js";

const env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.string().default("info"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(30000).default(180000),
  SOURCE_MODE: z.enum(["demo", "cricbuzz"]).default("demo"),
  CRICKET_SOURCE_ENABLED: z.string().default("false"),
  DATABASE_URL: z.string().optional(),
  CRICBUZZ_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  CRICBUZZ_MAX_MATCHES_PER_POLL: z.coerce.number().int().min(1).max(50).default(2),
  CRICBUZZ_MAX_PROFILES_PER_POLL: z.coerce.number().int().min(0).max(100).default(2),
  CRICBUZZ_MAX_TEAMS_PER_POLL: z.coerce.number().int().min(0).max(50).default(2),
  CRICBUZZ_MAX_SERIES_PER_POLL: z.coerce.number().int().min(0).max(50).default(1),
  CRICBUZZ_MAX_VENUES_PER_POLL: z.coerce.number().int().min(0).max(50).default(1),
  CRICBUZZ_TIMEOUT_MS: z.coerce.number().int().min(3000).max(60000).default(15000),
  CRICBUZZ_MAX_RESPONSE_BYTES: z.coerce.number().int().min(100000).max(20000000).default(8000000),
  CRICBUZZ_USER_AGENT: z.string().min(12).default("Crikora/0.1 (+https://github.com/Annant2122011/crikora; authorized data access)"),
  CORS_ORIGINS: z.string().default("")
}).parse(process.env);

if (env.SOURCE_MODE === "cricbuzz" && env.CRICKET_SOURCE_ENABLED !== "true") {
  throw new Error("Set CRICKET_SOURCE_ENABLED=true to enable the Cricbuzz collector.");
}
if (env.SOURCE_MODE === "demo" && env.CRICKET_SOURCE_ENABLED === "true") {
  throw new Error("Choose SOURCE_MODE=cricbuzz when enabling the Cricbuzz collector.");
}
if (env.SOURCE_MODE === "cricbuzz" && !env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Cricbuzz collection; the collector must persist to PostgreSQL.");
}

const app = Fastify({ logger: { level: env.LOG_LEVEL }, requestIdHeader: "x-request-id" });
const repository: EntityRepository = env.DATABASE_URL
  ? new PostgresEntityRepository(env.DATABASE_URL)
  : new MemoryEntityRepository();
if (repository instanceof PostgresEntityRepository) await repository.ping();

const provider = env.SOURCE_MODE === "cricbuzz"
  ? new CricbuzzProvider({
      minRequestIntervalMs: env.CRICBUZZ_MIN_REQUEST_INTERVAL_MS,
      maxMatchesPerPoll: env.CRICBUZZ_MAX_MATCHES_PER_POLL,
      maxProfilesPerPoll: env.CRICBUZZ_MAX_PROFILES_PER_POLL,
      maxTeamsPerPoll: env.CRICBUZZ_MAX_TEAMS_PER_POLL,
      maxSeriesPerPoll: env.CRICBUZZ_MAX_SERIES_PER_POLL,
      maxVenuesPerPoll: env.CRICBUZZ_MAX_VENUES_PER_POLL,
      timeoutMs: env.CRICBUZZ_TIMEOUT_MS,
      maxResponseBytes: env.CRICBUZZ_MAX_RESPONSE_BYTES,
      userAgent: env.CRICBUZZ_USER_AGENT
    })
  : new DemoProvider();

const poller = new Poller(provider, repository, env.POLL_INTERVAL_MS, error => {
  if (typeof error === "object" && error && "level" in error && error.level === "info") {
    app.log.info(error);
  } else {
    app.log.error({ err: error }, "Crikora ingestion cycle failed");
  }
});

await app.register(helmet);
const origins = env.CORS_ORIGINS.split(",").map(value => value.trim()).filter(Boolean);
await app.register(cors, { origin: origins.length ? origins : false });

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
function parseLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
}

app.get("/health", async (_request, reply) => {
  try {
    if (repository instanceof PostgresEntityRepository) await repository.ping();
    return { ok: true, service: "crikora-api", source: provider.id, storage: repository instanceof PostgresEntityRepository ? "postgres" : "memory", retentionSeconds: 600 };
  } catch {
    return reply.code(503).send({ ok: false, service: "crikora-api", storage: "unavailable" });
  }
});

app.get("/v1/entities/:entityType", async (request, reply) => {
  const params = z.object({ entityType: z.enum(ENTITY_TYPES) }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: "Unsupported entity type", allowed: ENTITY_TYPES });
  const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: "Invalid limit" });
  const rows = await repository.list(params.data.entityType, query.data.limit);
  return { data: rows.map(present), meta: { count: rows.length, retentionSeconds: 600, source: provider.id } };
});

app.get("/v1/entities/:entityType/:sourceId", async (request, reply) => {
  const params = z.object({ entityType: z.enum(ENTITY_TYPES), sourceId: z.string().min(1).max(200) }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: "Invalid entity path" });
  const row = await repository.get(params.data.entityType, params.data.sourceId);
  if (!row) return reply.code(404).send({ error: "Entity not found or expired" });
  return { data: present(row), meta: { retentionSeconds: 600, source: provider.id } };
});

app.get("/v1/matches", async (request, reply) => {
  const query = z.object({
    status: z.enum(["live", "upcoming", "completed"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
  }).safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: "Invalid match query" });
  const rows = await repository.list("match", query.data.limit);
  const data = rows.filter(row => !query.data.status || row.payload.status === query.data.status).map(present);
  return { data, meta: { count: data.length, retentionSeconds: 600, source: provider.id } };
});
app.get("/v1/matches/live", async () => {
  const rows = await repository.list("match", 500);
  const data = rows.filter(row => row.payload.status === "live").map(present);
  return { data, meta: { count: data.length, retentionSeconds: 600, source: provider.id } };
});
app.get("/v1/matches/upcoming", async () => {
  const rows = await repository.list("match", 500);
  const data = rows.filter(row => row.payload.status === "upcoming").map(present);
  return { data, meta: { count: data.length, retentionSeconds: 600, source: provider.id } };
});
app.get("/v1/matches/recent", async () => {
  const rows = await repository.list("match", 500);
  const data = rows.filter(row => row.payload.status === "completed").map(present);
  return { data, meta: { count: data.length, retentionSeconds: 600, source: provider.id } };
});
app.get("/v1/matches/:matchId/events", async (request, reply) => {
  const { matchId } = request.params as { matchId: string };
  const row = await repository.get("match", matchId.replace(/^cricbuzz:/, ""));
  if (!row) return reply.code(404).send({ error: "Match not found or expired" });
  return { data: Array.isArray(row.payload.events) ? row.payload.events : [], meta: { retentionSeconds: 600 } };
});
app.get("/v1/matches/:matchId", async (request, reply) => {
  const { matchId } = request.params as { matchId: string };
  const row = await repository.get("match", matchId.replace(/^cricbuzz:/, ""));
  if (!row) return reply.code(404).send({ error: "Match not found or expired" });
  return { data: present(row), meta: { retentionSeconds: 600, source: provider.id } };
});

for (const [route, type] of [
  ["/v1/players", "player"], ["/v1/teams", "team"],
  ["/v1/series", "series"], ["/v1/venues", "venue"]
] as const) {
  app.get(route, async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid limit" });
    const rows = await repository.list(type, query.data.limit);
    return { data: rows.map(present), meta: { count: rows.length, retentionSeconds: 600 } };
  });
}
app.get("/v1/search", async (request, reply) => {
  const query = z.object({ q: z.string().trim().min(1).max(120), limit: z.coerce.number().int().min(1).max(100).default(30) }).safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: "Supply a search term q and an optional limit." });
  const rows = await repository.search(query.data.q, query.data.limit);
  return { data: rows.map(present), meta: { count: rows.length, retentionSeconds: 600 } };
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error({ err: error }, "Crikora API request failed");
  reply.code(500).send({ error: "Internal server error" });
});

await repository.cleanupExpired();
const cleanupTimer = setInterval(() => {
  void repository.cleanupExpired().then(count => {
    if (count) app.log.info({ count }, "Expired Crikora cache rows deleted");
  }).catch(error => app.log.error({ err: error }, "Crikora TTL cleanup failed"));
}, 15_000);
cleanupTimer.unref();

await app.listen({ host: env.HOST, port: env.PORT });
void poller.tick().catch(() => undefined);
poller.start();

const close = async () => {
  clearInterval(cleanupTimer);
  poller.stop();
  await app.close();
  await repository.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
