import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { z } from "zod";
import { CricbuzzProvider } from "./providers/cricbuzz-provider.js";
import { ENTITY_TYPES, RETENTION_POLICY, type EntityRepository, type StoredEntity } from "./domain/entities.js";
import { PostgresEntityRepository } from "./storage/postgres-entity-repository.js";
import { Poller } from "./ingestion/poller.js";
import { isArchiveRepository } from "./storage/archive-repository.js";

const env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.string().default("info"),
  POLL_INTERVAL_SECONDS: z.enum(["10", "15", "20", "30"]).default("10"),
  CRIKORA_COLLECTION_ENABLED: z.enum(["true", "false"]).default("false"),
  DATABASE_URL: z.string().min(1),
  CRICBUZZ_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  CRICBUZZ_MAX_MATCHES_PER_POLL: z.coerce.number().int().min(1).max(50).default(2),
  CRICBUZZ_MAX_PROFILES_PER_POLL: z.coerce.number().int().min(0).max(100).default(2),
  CRICBUZZ_MAX_TEAMS_PER_POLL: z.coerce.number().int().min(0).max(50).default(2),
  CRICBUZZ_MAX_SERIES_PER_POLL: z.coerce.number().int().min(0).max(50).default(1),
  CRICBUZZ_MAX_VENUES_PER_POLL: z.coerce.number().int().min(0).max(50).default(1),
  CRICBUZZ_MAX_CONTENT_PAGES_PER_POLL: z.coerce.number().int().min(0).max(100).default(2),
  CRICBUZZ_TIMEOUT_MS: z.coerce.number().int().min(3000).max(60000).default(15000),
  CRICBUZZ_MAX_RESPONSE_BYTES: z.coerce.number().int().min(100000).max(20000000).default(8000000),
  CRICBUZZ_USER_AGENT: z.string().min(12).default("Crikora/0.1 (+https://github.com/Annant2122011/crikora; authorized data access)"),
  CORS_ORIGINS: z.string().default("")
}).parse(process.env);

async function startServer(): Promise<void> {
const app = Fastify({ logger: { level: env.LOG_LEVEL }, requestIdHeader: "x-request-id" });
const repository: EntityRepository = new PostgresEntityRepository(env.DATABASE_URL);
await (repository as PostgresEntityRepository).ping();

const provider = new CricbuzzProvider({
  minRequestIntervalMs: env.CRICBUZZ_MIN_REQUEST_INTERVAL_MS,
  maxMatchesPerPoll: env.CRICBUZZ_MAX_MATCHES_PER_POLL,
  maxProfilesPerPoll: env.CRICBUZZ_MAX_PROFILES_PER_POLL,
  maxTeamsPerPoll: env.CRICBUZZ_MAX_TEAMS_PER_POLL,
  maxSeriesPerPoll: env.CRICBUZZ_MAX_SERIES_PER_POLL,
  maxVenuesPerPoll: env.CRICBUZZ_MAX_VENUES_PER_POLL,
  maxContentPagesPerPoll: env.CRICBUZZ_MAX_CONTENT_PAGES_PER_POLL,
  timeoutMs: env.CRICBUZZ_TIMEOUT_MS,
  maxResponseBytes: env.CRICBUZZ_MAX_RESPONSE_BYTES,
  userAgent: env.CRICBUZZ_USER_AGENT
});

const poller = new Poller(provider, repository, Number(env.POLL_INTERVAL_SECONDS) * 1000, error => {
  if (typeof error === "object" && error && "level" in error && error.level === "info") {
    app.log.info(error);
  } else {
    app.log.error({ err: error }, "Crikora ingestion cycle failed");
  }
});

await app.register(helmet);
const origins = env.CORS_ORIGINS.split(",").map(value => value.trim()).filter(Boolean);
await app.register(cors, { origin: origins.length ? origins : false });

// Root discovery route: this is an API service, not the Crikora web frontend.
app.get("/", async () => ({
  ok: true,
  service: "crikora-api",
  source: provider.id,
  storage: "postgres",
  retentionPolicy: RETENTION_POLICY,
  collectionEnabled: env.CRIKORA_COLLECTION_ENABLED === "true",
  health: "/health",
  apiBasePath: "/v1",
  endpoints: {
    matches: "/v1/matches",
    liveMatches: "/v1/matches/live",
    upcomingMatches: "/v1/matches/upcoming",
    recentMatches: "/v1/matches/recent",
    players: "/v1/players",
    teams: "/v1/teams",
    series: "/v1/series",
    venues: "/v1/venues",
    content: "/v1/content",
    search: "/v1/search"
  }
}));

function present(row: StoredEntity): Record<string, unknown> {
  return {
    ...row.payload,
    id: row.sourceId,
    entityType: row.entityType,
    sourceUrl: row.sourceUrl,
    fetchedAt: row.fetchedAt,
    expiresAt: row.expiresAt,
    retentionClass: row.retentionClass,
    ttlSeconds: row.retentionClass === "ephemeral" ? RETENTION_POLICY.ephemeralSeconds : null
  };
}
app.get("/health", async (_request, reply) => {
  try {
    if (repository instanceof PostgresEntityRepository) await repository.ping();
    return {
      ok: true,
      service: "crikora-api",
      source: provider.id,
      storage: "postgres",
      retentionPolicy: RETENTION_POLICY,
      collectionEnabled: env.CRIKORA_COLLECTION_ENABLED === "true",
      refreshIntervalSeconds: Number(env.POLL_INTERVAL_SECONDS)
    };
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
  return { data: rows.map(present), meta: { count: rows.length, retentionPolicy: RETENTION_POLICY, source: provider.id } };
});

app.get("/v1/entities/:entityType/:sourceId", async (request, reply) => {
  const params = z.object({ entityType: z.enum(ENTITY_TYPES), sourceId: z.string().min(1).max(200) }).safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: "Invalid entity path" });
  const row = await repository.get(params.data.entityType, params.data.sourceId);
  if (!row) return reply.code(404).send({ error: "Entity not found or expired" });
  return { data: present(row), meta: { retentionPolicy: RETENTION_POLICY, source: provider.id } };
});

app.get("/v1/entities/:entityType/:sourceId/details", async (request, reply) => {
  const params = z.object({
    entityType: z.enum(ENTITY_TYPES),
    sourceId: z.string().min(1).max(200)
  }).safeParse(request.params);
  const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).safeParse(request.query);
  if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid entity details query." });
  if (!isArchiveRepository(repository)) return reply.code(503).send({ error: "Permanent archive storage is unavailable." });
  const current = await repository.get(params.data.entityType, params.data.sourceId);
  const latestHistory = current ? [] : await repository.listEntityHistory(params.data.entityType, params.data.sourceId, 1);
  const related = await repository.listRelatedEntityPages(params.data.entityType, params.data.sourceId, query.data.limit);
  const entity = current ? present(current) : latestHistory[0] ?? null;
  if (!entity && !related.length) return reply.code(404).send({ error: "Entity and its archived detail pages were not found." });
  return {
    data: { entity, related },
    meta: { relatedCount: related.length, retention: "permanent", source: provider.id }
  };
});

app.get("/v1/matches", async (request, reply) => {
  const query = z.object({
    status: z.enum(["live", "upcoming", "completed"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
  }).safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: "Invalid match query" });
  const rows = await repository.list("match", query.data.limit);
  const data = rows.filter(row => !query.data.status || row.payload.status === query.data.status).map(present);
  return { data, meta: { count: data.length, retentionPolicy: RETENTION_POLICY, source: provider.id } };
});
app.get("/v1/matches/live", async () => {
  const rows = await repository.list("match", 500);
  const data = rows.filter(row => row.payload.status === "live").map(present);
  return { data, meta: { count: data.length, retentionPolicy: RETENTION_POLICY, source: provider.id } };
});
app.get("/v1/matches/upcoming", async () => {
  const rows = await repository.list("match", 500);
  const data = rows.filter(row => row.payload.status === "upcoming").map(present);
  return { data, meta: { count: data.length, retentionPolicy: RETENTION_POLICY, source: provider.id } };
});
app.get("/v1/matches/recent", async () => {
  const rows = await repository.list("match", 500);
  const data = rows.filter(row => row.payload.status === "completed").map(present);
  return { data, meta: { count: data.length, retentionPolicy: RETENTION_POLICY, source: provider.id } };
});
app.get("/v1/matches/:matchId/events", async (request, reply) => {
  const { matchId } = request.params as { matchId: string };
  const row = await repository.get("match", matchId.replace(/^cricbuzz:/, ""));
  if (!row) return reply.code(404).send({ error: "Match not found or expired" });
  return { data: Array.isArray(row.payload.events) ? row.payload.events : [], meta: { retentionPolicy: RETENTION_POLICY } };
});
app.get("/v1/matches/:matchId", async (request, reply) => {
  const { matchId } = request.params as { matchId: string };
  const row = await repository.get("match", matchId.replace(/^cricbuzz:/, ""));
  if (!row) return reply.code(404).send({ error: "Match not found or expired" });
  return { data: present(row), meta: { retentionPolicy: RETENTION_POLICY, source: provider.id } };
});

for (const [route, type] of [
  ["/v1/players", "player"], ["/v1/teams", "team"],
  ["/v1/series", "series"], ["/v1/venues", "venue"]
] as const) {
  app.get(route, async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid limit" });
    const rows = await repository.list(type, query.data.limit);
    return { data: rows.map(present), meta: { count: rows.length, retentionPolicy: RETENTION_POLICY } };
  });
  app.get(`${route}/:sourceId`, async (request, reply) => {
    const { sourceId } = request.params as { sourceId: string };
    const row = await repository.get(type, sourceId);
    if (!row) return reply.code(404).send({ error: "Entity not found or expired" });
    return { data: present(row), meta: { retentionPolicy: RETENTION_POLICY } };
  });
}
app.get("/v1/content", async (request, reply) => {
  const query = z.object({
    kind: z.string().trim().min(1).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
  }).safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: "Invalid content query" });
  const rows = await repository.list("metadata", 500);
  const data = rows
    .filter(row => !query.data.kind || row.payload.pageKind === query.data.kind)
    .slice(0, query.data.limit)
    .map(present);
  return {
    data,
    meta: { count: data.length, kind: query.data.kind ?? "all", retentionPolicy: RETENTION_POLICY, source: provider.id }
  };
});

app.get("/v1/search", async (request, reply) => {
  const query = z.object({ q: z.string().trim().min(1).max(120), limit: z.coerce.number().int().min(1).max(100).default(30) }).safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: "Supply a search term q and an optional limit." });
  const rows = await repository.search(query.data.q, query.data.limit);
  return { data: rows.map(present), meta: { count: rows.length, retentionPolicy: RETENTION_POLICY } };
});

app.get("/v1/archive/coverage", async (_request, reply) => {
  if (!isArchiveRepository(repository)) return reply.code(503).send({ error: "Permanent archive storage is unavailable." });
  const data = await repository.getArchiveCoverage();
  return { data, meta: { retention: "permanent", appendOnly: true } };
});

app.get("/v1/archive/entities/:entityType", async (request, reply) => {
  const params = z.object({ entityType: z.enum(ENTITY_TYPES) }).safeParse(request.params);
  const query = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().min(1).optional()
  }).safeParse(request.query);
  if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid archive entity query." });
  if (!isArchiveRepository(repository)) return reply.code(503).send({ error: "Permanent archive storage is unavailable." });
  const data = await repository.listArchivedEntities(params.data.entityType, query.data.limit, query.data.before);
  return {
    data,
    meta: { count: data.length, nextBefore: data.at(-1)?.id ?? null, retention: "permanent", appendOnly: true }
  };
});

app.get("/v1/archive/entities/:entityType/:sourceId/history", async (request, reply) => {
  const params = z.object({
    entityType: z.enum(ENTITY_TYPES),
    sourceId: z.string().min(1).max(200)
  }).safeParse(request.params);
  const query = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().min(1).optional().refine(value => !value || /^[0-9]+$/.test(value) || !Number.isNaN(Date.parse(value)))
  }).safeParse(request.query);
  if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid archive history query." });
  if (!isArchiveRepository(repository)) return reply.code(503).send({ error: "Permanent archive storage is unavailable." });
  const data = await repository.listEntityHistory(
    params.data.entityType, params.data.sourceId, query.data.limit, query.data.before
  );
  return { data, meta: { count: data.length, nextBefore: data.at(-1)?.id ?? null, retention: "permanent", appendOnly: true } };
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
}, 5_000);
cleanupTimer.unref();

await app.listen({ host: env.HOST, port: env.PORT });
if (env.CRIKORA_COLLECTION_ENABLED === "true") {
  void poller.tick().catch(() => undefined);
  poller.start();
}

const close = async () => {
  clearInterval(cleanupTimer);
  poller.stop();
  await app.close();
  await repository.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

}

void startServer().catch(error => {
  console.error("Crikora startup failed", error);
  process.exitCode = 1;
});
