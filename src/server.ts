import "dotenv/config";
import Fastify from "fastify";
import { Pool } from "pg";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { z } from "zod";
import { CricbuzzProvider, dedupeCricbuzzPageUrls } from "./providers/cricbuzz-provider.js";
import { ENTITY_TYPES, RETENTION_POLICY, type EntityRepository, type StoredEntity } from "./domain/entities.js";
import { PostgresEntityRepository } from "./storage/postgres-entity-repository.js";
import { createArchiveObjectStoreFromEnv } from "./storage/neon-s3-archive-object-store.js";
import { Poller } from "./ingestion/poller.js";
import { DurableCrawlService } from "./ingestion/durable-crawl.js";
import { isArchiveRepository } from "./storage/archive-repository.js";

const env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.string().default("info"),
  POLL_INTERVAL_SECONDS: z.enum(["10", "15", "20", "30"]).default("10"),
  CRIKORA_COLLECTION_ENABLED: z.enum(["true", "false"]).default("false"),
  CRIKORA_AUTO_POLL_ENABLED: z.enum(["true", "false"]).default("false"),
  CRIKORA_ADMIN_SECRET: z.string().min(24).optional(),
  CRIKORA_REFRESH_SECRET: z.string().min(24).optional(),
  CRIKORA_CRAWL_BATCH_SIZE: z.coerce.number().int().min(1).max(3).default(2),
  CRIKORA_CRAWL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(8).default(4),
  CRIKORA_CRICINFO_FALLBACK_ENABLED: z.enum(["true", "false"]).default("true"),
  DATABASE_URL: z.string().min(1),
  AWS_ENDPOINT_URL_S3: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  CRIKORA_ARCHIVE_BUCKET: z.string().optional(),
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
// Read the five Neon Object Storage variables from the same process environment
// loaded by dotenv/config or injected by the production host. Never expose them in API responses.
const archiveObjectStore = createArchiveObjectStoreFromEnv(process.env);
const repository: EntityRepository = new PostgresEntityRepository(env.DATABASE_URL, archiveObjectStore);
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
  userAgent: env.CRICBUZZ_USER_AGENT,
  cricinfoFallbackEnabled: env.CRIKORA_CRICINFO_FALLBACK_ENABLED === "true"
});

const poller = new Poller(provider, repository, Number(env.POLL_INTERVAL_SECONDS) * 1000, error => {
  if (typeof error === "object" && error && "level" in error && error.level === "info") {
    app.log.info(error);
  } else {
    app.log.error({ err: error }, "Crikora ingestion cycle failed");
  }
});

const crawlPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 6,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "crikora-railway-api-crawl"
});
const durableCrawl = new DurableCrawlService(
  crawlPool,
  provider,
  repository,
  env.CRIKORA_CRAWL_BATCH_SIZE,
  env.CRIKORA_CRAWL_MAX_ATTEMPTS
);

interface CrawlerSettingsRow {
  refresh_interval_seconds: number;
  enabled: boolean;
  last_started_at: Date | string | null;
  last_completed_at: Date | string | null;
  lease_until: Date | string | null;
  last_error: string | null;
  updated_at: Date | string;
}

async function getCrawlerSettings(): Promise<CrawlerSettingsRow> {
  const result = await crawlPool.query<CrawlerSettingsRow>(
    "SELECT refresh_interval_seconds, enabled, last_started_at, last_completed_at, lease_until, last_error, updated_at FROM public.crikora_crawler_settings WHERE id = 1"
  );
  const row = result.rows[0];
  if (!row) throw new Error("Crikora crawler settings row is missing. Apply migration 002.");
  return row;
}

function authMatches(authorization: string | undefined, expected: string | undefined): boolean {
  if (!authorization || !expected) return false;
  const provided = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function savedTargetedCricketInventory(): string[] {
  const inventoryPath = join(process.cwd(), "docs", "cricbuzz-sitemap-inventory.json");
  const parsed = JSON.parse(readFileSync(inventoryPath, "utf8")) as { urls?: Array<string | { url?: string }> };
  if (!Array.isArray(parsed.urls)) throw new Error("The saved Cricbuzz inventory has no URL list.");
  return [...new Set(parsed.urls
    .map(item => typeof item === "string" ? item : item.url ?? "")
    .filter(value => provider.isAllowedCrawlUrl(value))
    .filter(value => !/^https:\/\/www\.cricbuzz\.com\/(?:cricket-match-facts|cricket-match-squads|live-cricket-full-commentary|cricket-match-highlights|live-cricket-graphs|live-cricket-over-by-over|cricket-match-forecast|special-content\/wicket-zone|player-match-highlights)\//i.test(value)))];
}


await app.register(helmet);
const origins = env.CORS_ORIGINS.split(",").map(value => value.trim()).filter(Boolean);
await app.register(cors, { origin: origins.length ? origins : false });

// Root discovery route: this is an API service, not the Crikora web frontend.
app.get("/", async (request, reply) => {
  const acceptHeader = request.headers.accept || "";
  
  // Serve HTML page with analytics when accessed from a browser
  if (acceptHeader.includes("text/html")) {
    reply.type("text/html");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crikora API</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6;
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #333;
      border-bottom: 3px solid #0070f3;
      padding-bottom: 10px;
    }
    h2 {
      color: #0070f3;
      margin-top: 30px;
    }
    code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }
    .endpoint {
      background: #f9f9f9;
      padding: 15px;
      margin: 10px 0;
      border-left: 4px solid #0070f3;
      border-radius: 4px;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      background: #0070f3;
      color: white;
      border-radius: 4px;
      font-size: 0.85em;
      margin-right: 8px;
    }
    a {
      color: #0070f3;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🏏 Crikora Cricket API</h1>
    <p>A cricket data ingestion and highlights API providing real-time match data, player profiles, team information, and more.</p>
    
    <h2>API Information</h2>
    <div class="endpoint">
      <strong>Service:</strong> crikora-api<br>
      <strong>Source:</strong> ${provider.id}<br>
      <strong>Storage:</strong> postgres<br>\n      <strong>Archive object storage:</strong> ${archiveObjectStore ? "configured" : "local fallback"}<br>
      <strong>Collection Enabled:</strong> ${env.CRIKORA_COLLECTION_ENABLED === "true"}<br>
    </div>

    <h2>Available Endpoints</h2>
    
    <div class="endpoint">
      <span class="badge">GET</span>
      <code>/health</code> - API health check
    </div>
    
    <div class="endpoint">
      <span class="badge">GET</span>
      <code>/v1/matches</code> - List all matches<br>
      <span class="badge">GET</span>
      <code>/v1/matches/live</code> - Live matches<br>
      <span class="badge">GET</span>
      <code>/v1/matches/upcoming</code> - Upcoming matches<br>
      <span class="badge">GET</span>
      <code>/v1/matches/recent</code> - Recent matches
    </div>
    
    <div class="endpoint">
      <span class="badge">GET</span>
      <code>/v1/players</code> - List players<br>
      <span class="badge">GET</span>
      <code>/v1/teams</code> - List teams<br>
      <span class="badge">GET</span>
      <code>/v1/series</code> - List series<br>
      <span class="badge">GET</span>
      <code>/v1/venues</code> - List venues
    </div>
    
    <div class="endpoint">
      <span class="badge">GET</span>
      <code>/v1/content</code> - Content feed (news, videos, galleries)<br>
      <span class="badge">GET</span>
      <code>/v1/search?q=query</code> - Search API
    </div>

    <h2>Quick Start</h2>
    <p>Try these example requests:</p>
    <ul>
      <li><a href="/health">/health</a> - Check API status</li>
      <li><a href="/v1/matches/live">/v1/matches/live</a> - View live matches</li>
      <li><a href="/v1/players?limit=10">/v1/players?limit=10</a> - List players</li>
    </ul>

    <h2>Documentation</h2>
    <p>For detailed API documentation and usage examples, visit the <a href="https://github.com/Annant2122011/crikora" target="_blank">GitHub repository</a>.</p>
  </div>

  <script>
    // Vercel Web Analytics
    (function() {
      var script = document.createElement('script');
      script.src = '/_vercel/insights/script.js';
      script.defer = true;
      document.head.appendChild(script);
    })();
  </script>
</body>
</html>`;
  }
  
  // Return JSON for API clients
  return {
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
  };
});

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
      archiveObjectStorage: archiveObjectStore ? "configured" : "local-bytea-fallback",
      retentionPolicy: RETENTION_POLICY,
      collectionEnabled: env.CRIKORA_COLLECTION_ENABLED === "true",
      refreshIntervalSeconds: Number(env.POLL_INTERVAL_SECONDS)
    };
  } catch {
    return reply.code(503).send({ ok: false, service: "crikora-api", storage: "unavailable" });
  }
});

app.get("/v1/settings", async (request, reply) => {
  if (!authMatches(request.headers.authorization, env.CRIKORA_ADMIN_SECRET)) {
    return reply.code(env.CRIKORA_ADMIN_SECRET ? 401 : 503).send({ error: env.CRIKORA_ADMIN_SECRET ? "Unauthorized" : "CRIKORA_ADMIN_SECRET is not configured." });
  }
  const settings = await getCrawlerSettings();
  return {
    data: {
      enabled: settings.enabled,
      refreshIntervalSeconds: settings.refresh_interval_seconds,
      lastStartedAt: settings.last_started_at,
      lastCompletedAt: settings.last_completed_at,
      updatedAt: settings.updated_at
    }
  };
});

app.put("/v1/settings", async (request, reply) => {
  if (!authMatches(request.headers.authorization, env.CRIKORA_ADMIN_SECRET)) {
    return reply.code(env.CRIKORA_ADMIN_SECRET ? 401 : 503).send({ error: env.CRIKORA_ADMIN_SECRET ? "Unauthorized" : "CRIKORA_ADMIN_SECRET is not configured." });
  }
  const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
  const interval = body.refreshIntervalSeconds === undefined ? undefined : Number(body.refreshIntervalSeconds);
  if (interval !== undefined && (!Number.isInteger(interval) || ![10, 15, 20, 30].includes(interval))) {
    return reply.code(400).send({ error: "refreshIntervalSeconds must be 10, 15, 20 or 30." });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return reply.code(400).send({ error: "enabled must be a boolean." });
  }
  if (body.enabled === true && env.CRIKORA_COLLECTION_ENABLED !== "true") {
    return reply.code(403).send({ error: "Collection is disabled by the CRIKORA_COLLECTION_ENABLED server switch." });
  }
  const updated = await crawlPool.query<CrawlerSettingsRow>(
    "UPDATE public.crikora_crawler_settings\nSET refresh_interval_seconds = COALESCE($1, refresh_interval_seconds), enabled = COALESCE($2, enabled), lease_until = CASE WHEN $2::boolean IS TRUE THEN NULL ELSE lease_until END, last_started_at = CASE WHEN $2::boolean IS TRUE THEN NULL ELSE last_started_at END, updated_at = now()\nWHERE id = 1\nRETURNING refresh_interval_seconds, enabled, last_started_at, last_completed_at, lease_until, last_error, updated_at",
    [interval ?? null, body.enabled ?? null]
  );
  const settings = updated.rows[0];
  return {
    data: {
      enabled: settings?.enabled,
      refreshIntervalSeconds: settings?.refresh_interval_seconds,
      lastStartedAt: settings?.last_started_at,
      lastCompletedAt: settings?.last_completed_at,
      updatedAt: settings?.updated_at
    },
    meta: { availableIntervalsSeconds: [10, 15, 20, 30] }
  };
});

app.post("/v1/crawl/start", async (request, reply) => {
  if (!authMatches(request.headers.authorization, env.CRIKORA_ADMIN_SECRET)) {
    return reply.code(env.CRIKORA_ADMIN_SECRET ? 401 : 503).send({ error: env.CRIKORA_ADMIN_SECRET ? "Unauthorized" : "CRIKORA_ADMIN_SECRET is not configured." });
  }
  if (env.CRIKORA_COLLECTION_ENABLED !== "true") {
    return reply.code(403).send({ error: "Collection is disabled by the CRIKORA_COLLECTION_ENABLED server switch." });
  }
  const savedTargetedUrls = savedTargetedCricketInventory();
  const savedNewsUrls = savedTargetedUrls.filter(value => value.includes("/cricket-news/"));
  const savedPlayerUrls = savedTargetedUrls.filter(value => value.includes("/profiles/"));
  let newsUrls: string[] = [];
  let playerUrls: string[] = [];
  let sitemapPageUrls: string[] = [];
  let sitemapDocumentCount = 0;
  const discoveryErrors: string[] = [];
  for (const [label, discover] of [
    ["news", () => provider.discoverNewsSitemapUrls(AbortSignal.timeout(25_000))],
    ["players", () => provider.discoverPlayerSitemapUrls(AbortSignal.timeout(25_000))]
  ] as const) {
    try {
      const found = await discover();
      if (label === "news") newsUrls = found;
      else playerUrls = found;
    } catch (error) {
      const status = error && typeof error === "object" && "sourceStatus" in error
        ? Number((error as { sourceStatus?: unknown }).sourceStatus)
        : undefined;
      if (status === 429 || (status !== undefined && status >= 500) || status === undefined) throw error;
      discoveryErrors.push(label + " sitemap unavailable (HTTP " + status + "); using saved targeted inventory.");
    }
  }
  try {
    const discovery = await provider.discoverSitemapUrls(AbortSignal.timeout(25_000));
    sitemapPageUrls = discovery.pageUrls
      .filter(value => provider.isAllowedCrawlUrl(value))
      .filter(value => !/^https:\/\/www\.cricbuzz\.com\/(?:cricket-match-facts|cricket-match-squads|live-cricket-full-commentary|cricket-match-highlights|live-cricket-graphs|live-cricket-over-by-over|cricket-match-forecast|special-content\/wicket-zone|player-match-highlights)\//i.test(value));
    sitemapDocumentCount = discovery.sitemapUrls.length;
  } catch (error) {
    const status = error && typeof error === "object" && "sourceStatus" in error
      ? Number((error as { sourceStatus?: unknown }).sourceStatus)
      : undefined;
    if (status === 429 || (status !== undefined && status >= 500) || status === undefined) throw error;
    discoveryErrors.push("Cricbuzz sitemap index unavailable (HTTP " + status + "); using saved inventory and focused sitemaps.");
  }
  const selectedNewsUrls = newsUrls.length ? newsUrls : savedNewsUrls;
  const selectedPlayerUrls = playerUrls.length ? playerUrls : savedPlayerUrls;
  const crawlUrls = dedupeCricbuzzPageUrls([
    ...provider.getTargetedCollectionSeedUrls(),
    ...sitemapPageUrls,
    ...savedTargetedUrls,
    ...selectedNewsUrls,
    ...selectedPlayerUrls
  ]);
  const result = await durableCrawl.startTargetedCrawl(crawlUrls);
  return reply.code(result.created ? 202 : 200).send({
    ok: true,
    scope: "targeted-product",
    created: result.created,
    resumed: result.resumed,
    data: result.run,
    meta: {
      matchIndexSeedCount: provider.getTargetedCollectionSeedUrls().filter(value => /cricket-match\/live-scores/.test(value)).length,
      scheduleIndexSeedCount: provider.getTargetedCollectionSeedUrls().filter(value => /cricket-schedule/.test(value)).length,
      newsArticleSeedCount: selectedNewsUrls.length,
      playerProfileSeedCount: selectedPlayerUrls.length,
      savedTargetedUrlCount: savedTargetedUrls.length,
      sitemapDocumentCount,
      sitemapPageUrlCount: sitemapPageUrls.length,
      discoveryErrors,
      crawlUrlCount: crawlUrls.length
    }
  });
});

app.get("/v1/crawl/status", async (request, reply) => {
  if (!authMatches(request.headers.authorization, env.CRIKORA_ADMIN_SECRET)) {
    return reply.code(env.CRIKORA_ADMIN_SECRET ? 401 : 503).send({ error: env.CRIKORA_ADMIN_SECRET ? "Unauthorized" : "CRIKORA_ADMIN_SECRET is not configured." });
  }
  return { data: await durableCrawl.getLatestStatus() ?? null };
});

app.post("/v1/crawl/step", async (request, reply) => {
  if (!authMatches(request.headers.authorization, env.CRIKORA_REFRESH_SECRET)) {
    return reply.code(env.CRIKORA_REFRESH_SECRET ? 401 : 503).send({ error: env.CRIKORA_REFRESH_SECRET ? "Unauthorized" : "CRIKORA_REFRESH_SECRET is not configured." });
  }
  if (env.CRIKORA_COLLECTION_ENABLED !== "true") {
    return reply.code(403).send({ error: "Collection is disabled by the CRIKORA_COLLECTION_ENABLED server switch." });
  }
  const settings = await getCrawlerSettings();
  if (!settings.enabled) return reply.code(409).send({ error: "The crawler is currently disabled." });
  const step = await durableCrawl.processBatch(AbortSignal.timeout(50_000));
  const run = await durableCrawl.getLatestStatus();
  if (step.retryAfterSeconds && step.retryAfterSeconds > 0) {
    reply.header("retry-after", String(step.retryAfterSeconds));
  }
  return { ok: true, ...step, run: run ?? null };
});

app.post("/v1/refresh/index", async (request, reply) => {
  if (!authMatches(request.headers.authorization, env.CRIKORA_REFRESH_SECRET)) {
    return reply.code(env.CRIKORA_REFRESH_SECRET ? 401 : 503).send({ error: env.CRIKORA_REFRESH_SECRET ? "Unauthorized" : "CRIKORA_REFRESH_SECRET is not configured." });
  }
  if (env.CRIKORA_COLLECTION_ENABLED !== "true") {
    return reply.code(403).send({ error: "Collection is disabled by the CRIKORA_COLLECTION_ENABLED server switch." });
  }
  const settings = await getCrawlerSettings();
  if (!settings.enabled) return reply.code(409).send({ error: "The crawler is currently disabled." });
  await poller.tick(AbortSignal.timeout(50_000), true);
  return {
    ok: true,
    status: "completed",
    refreshIntervalSeconds: settings.refresh_interval_seconds,
    queuedFollowups: 0
  };
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
    before: z.string().regex(/^[0-9]+$/).optional()
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
if (env.CRIKORA_AUTO_POLL_ENABLED === "true") {
  void poller.tick().catch(() => undefined);
  poller.start();
}

const close = async () => {
  clearInterval(cleanupTimer);
  poller.stop();
  await app.close();
  await repository.close();
  await crawlPool.end();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

}

void startServer().catch(error => {
  console.error("Crikora startup failed", error);
  process.exitCode = 1;
});
