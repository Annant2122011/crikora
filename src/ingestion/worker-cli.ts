import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

interface ApiBody {
  data?: unknown;
  error?: string;
  active?: boolean;
  status?: string;
  retryAfterSeconds?: number;
  run?: {
    status?: string;
    runId?: string;
    pendingCount?: number;
    processingCount?: number;
    processedCount?: number;
    failedCount?: number;
    skippedCount?: number;
    totalCount?: number;
  };
  [key: string]: unknown;
}

interface Config {
  apiBaseUrl: string;
  databaseUrl: string;
  adminSecret: string;
  refreshSecret: string;
  leaseSeconds: number;
  idlePollSeconds: number;
  stepTimeoutMs: number;
  startFullCrawlOnEnable: boolean;
  workerEnabled: boolean;
}

interface ApiResult {
  status: number;
  headers: Headers;
  body: ApiBody;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const stopped = { value: false };

function log(message: string, details?: unknown): void {
  const timestamp = new Date().toISOString();
  if (details === undefined) console.log(`[${timestamp}] ${message}`);
  else console.log(`[${timestamp}] ${message}`, details);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function readConfig(): Config {
  const leaseSeconds = Number(process.env.CRIKORA_WORKER_LEASE_SECONDS ?? 300);
  const idlePollSeconds = Number(process.env.CRIKORA_WORKER_IDLE_POLL_SECONDS ?? 10);
  const stepTimeoutMs = Number(process.env.CRIKORA_WORKER_STEP_TIMEOUT_MS ?? 180_000);
  if (!Number.isInteger(stepTimeoutMs) || stepTimeoutMs < 60_000 || stepTimeoutMs > 300_000) {
    throw new RangeError("CRIKORA_WORKER_STEP_TIMEOUT_MS must be between 60000 and 300000.");
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 7_200) {
    throw new RangeError("CRIKORA_WORKER_LEASE_SECONDS must be between 60 and 7200.");
  }
  if (leaseSeconds * 1000 < stepTimeoutMs + 30_000) {
    throw new RangeError("CRIKORA_WORKER_LEASE_SECONDS must exceed the worker step timeout by at least 30 seconds.");
  }
  if (!Number.isInteger(idlePollSeconds) || idlePollSeconds < 5 || idlePollSeconds > 60) {
    throw new RangeError("CRIKORA_WORKER_IDLE_POLL_SECONDS must be between 5 and 60.");
  }

  const apiBaseUrl = requiredEnv("CRIKORA_API_BASE_URL");
  const parsed = new URL(apiBaseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("CRIKORA_API_BASE_URL must use HTTPS (HTTP is allowed only for localhost).");
  }

  return {
    apiBaseUrl: apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`,
    databaseUrl: requiredEnv("DATABASE_URL"),
    adminSecret: requiredEnv("CRIKORA_ADMIN_SECRET"),
    refreshSecret: requiredEnv("CRIKORA_REFRESH_SECRET"),
    leaseSeconds,
    idlePollSeconds,
    stepTimeoutMs,
    startFullCrawlOnEnable: process.env.CRIKORA_START_FULL_CRAWL === "true",
    workerEnabled: process.env.CRIKORA_WORKER_ENABLED !== "false"
  };
}

async function requestApi(
  config: Config,
  path: string,
  method: "GET" | "POST",
  secret: "admin" | "refresh",
  timeoutMs = 55_000
): Promise<ApiResult> {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${secret === "admin" ? config.adminSecret : config.refreshSecret}`
  });
  if (method === "POST") headers.set("content-type", "application/json");

  const response = await fetch(new URL(path.replace(/^\/+/, ""), config.apiBaseUrl), {
    method,
    headers,
    ...(method === "POST" ? { body: "{}" } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs)
  });

  const raw = await response.text();
  let body: ApiBody = {};
  if (raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as ApiBody;
      }
    } catch {
      body = { error: raw.slice(0, 500) };
    }
  }

  const headerRetry = Number(response.headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(headerRetry) && headerRetry > 0
    ? Math.min(7_200, Math.ceil(headerRetry))
    : typeof body.retryAfterSeconds === "number" && Number.isFinite(body.retryAfterSeconds)
      ? Math.min(7_200, Math.max(1, Math.ceil(body.retryAfterSeconds)))
      : undefined;

  return { status: response.status, headers: response.headers, body: { ...body, retryAfterSeconds } };
}

function assertApiSuccess(result: ApiResult, label: string): void {
  if (result.status >= 200 && result.status < 300) return;
  throw new ApiError(
    `${label} returned HTTP ${result.status}: ${result.body.error ?? "No error detail returned"}`,
    result.status,
    result.body.retryAfterSeconds
  );
}

async function acquireLease(pool: Pool, token: string, leaseSeconds: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE public.crikora_worker_state
        SET lease_token = $1,
            lease_until = now() + make_interval(secs => $2),
            updated_at = now()
      WHERE id = 1
        AND (lease_until IS NULL OR lease_until <= now())
      RETURNING id`,
    [token, leaseSeconds]
  );
  return result.rowCount === 1;
}

async function renewLease(pool: Pool, token: string, leaseSeconds: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE public.crikora_worker_state
        SET lease_until = now() + make_interval(secs => $2),
            updated_at = now()
      WHERE id = 1
        AND lease_token = $1
        AND lease_until > now()
      RETURNING id`,
    [token, leaseSeconds]
  );
  return result.rowCount === 1;
}

async function releaseLease(pool: Pool, token: string): Promise<void> {
  await pool.query(
    `UPDATE public.crikora_worker_state
        SET lease_until = NULL,
            lease_token = NULL,
            updated_at = now()
      WHERE id = 1 AND lease_token = $1`,
    [token]
  );
}

async function waitWithLease(
  pool: Pool,
  token: string,
  leaseSeconds: number,
  seconds: number
): Promise<boolean> {
  let remainingMs = Math.max(1_000, Math.min(7_200_000, Math.ceil(seconds) * 1000));
  while (remainingMs > 0 && !stopped.value) {
    const part = Math.min(30_000, remainingMs);
    await new Promise(resolve => setTimeout(resolve, part));
    remainingMs -= part;
    if (stopped.value) return false;
    if (!await renewLease(pool, token, leaseSeconds)) {
      log("Worker lease was lost while waiting; stopping to prevent duplicate workers.");
      return false;
    }
  }
  return !stopped.value;
}

async function startFullCrawl(config: Config): Promise<void> {
  // The API performs a sequential public-sitemap refresh before seeding the queue.
  // Match the API's 45-second discovery budget while staying inside Vercel's 60-second limit.
  const result = await requestApi(config, "crawl/start", "POST", "admin", 50_000);
  assertApiSuccess(result, "Full-crawl start");
  const data = result.body.data as Record<string, unknown> | undefined;
  log("Full crawl accepted by the API.", {
    runId: data?.runId,
    status: data?.status,
    seededUrlCount: data?.seededUrlCount,
    totalCount: data?.totalCount
  });
}

async function readSettings(config: Config): Promise<{ enabled: boolean; refreshIntervalSeconds: number }> {
  const result = await requestApi(config, "settings", "GET", "admin", 10_000);
  assertApiSuccess(result, "Settings");
  const data = result.body.data as Record<string, unknown> | undefined;
  const enabled = data?.enabled;
  const interval = Number(data?.refreshIntervalSeconds);
  if (typeof enabled !== "boolean" || ![10, 15, 20, 30].includes(interval)) {
    throw new Error("The core API returned invalid crawler settings.");
  }
  return { enabled, refreshIntervalSeconds: interval };
}

async function readCrawlStatus(config: Config): Promise<Record<string, unknown> | null> {
  const result = await requestApi(config, "crawl/status", "GET", "admin", 15_000);
  assertApiSuccess(result, "Crawl status");
  return result.body.data && typeof result.body.data === "object"
    ? result.body.data as Record<string, unknown>
    : null;
}

async function processCrawlStep(config: Config): Promise<{ active: boolean; retryAfterSeconds: number }> {
  // A profile page can require the HTML fetch, structured-data decoding,
  // profile-tab extraction and optional ESPNcricinfo fallback. Railway's
  // long-running worker can wait longer than a serverless function request.
  const result = await requestApi(config, "crawl/step", "POST", "refresh", config.stepTimeoutMs);
  if (result.status === 401 || result.status === 403 || result.status === 409) {
    throw new ApiError(
      `Crawl step stopped by the core API: ${result.body.error ?? result.status}`,
      result.status
    );
  }
  if (result.status === 429) {
    return { active: true, retryAfterSeconds: result.body.retryAfterSeconds ?? 30 };
  }
  assertApiSuccess(result, "Crawl step");

  if (result.body.status === "paused") {
    throw new ApiError(
      `Full crawl paused by the source response: ${result.body.error ?? "access denied"}`,
      403
    );
  }
  const run = result.body.run;
  if (run) {
    log("Full-crawl progress", {
      status: run.status,
      processed: run.processedCount,
      failed: run.failedCount,
      skipped: run.skippedCount,
      pending: run.pendingCount,
      total: run.totalCount
    });
  }
  return {
    active: result.body.active === true,
    retryAfterSeconds: result.body.retryAfterSeconds ?? 1
  };
}

async function runRefresh(config: Config): Promise<number> {
  // Only refresh the compact live/upcoming/recent match indexes here.
  // The durable crawl owns player-profile, schedule and match-detail enrichment.
  const result = await requestApi(config, "refresh/index", "POST", "refresh", 55_000);
  if (result.status === 401 || result.status === 403 || result.status === 409) {
    throw new ApiError(
      `Refresh stopped by the core API: ${result.body.error ?? result.status}`,
      result.status
    );
  }
  if (result.status === 429) {
    const delay = result.body.retryAfterSeconds ?? 30;
    log("Source/API requested a refresh backoff.", { retryAfterSeconds: delay });
    return delay;
  }
  if (!result.status || result.status >= 500) {
    log("Refresh failed; retrying with a 30-second delay.", {
      status: result.status,
      error: result.body.error
    });
    return 30;
  }
  assertApiSuccess(result, "Refresh");
  log("Live refresh completed.", {
    refreshIntervalSeconds: result.body.refreshIntervalSeconds,
    queuedFollowups: result.body.queuedFollowups
  });
  return 0;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log([
      "Crikora standalone scraper worker",
      "",
      "Run: npm run worker:local",
      "Start/resume the full sitemap crawl: npm run worker:local -- --start-crawl",
      "Run one scheduler pass and exit: npm run worker:local -- --once",
      "",
      "Requires DATABASE_URL, CRIKORA_API_BASE_URL, CRIKORA_ADMIN_SECRET and CRIKORA_REFRESH_SECRET."
    ].join("\n"));
    return;
  }

  const config = readConfig();
  if (!config.workerEnabled) {
    log("Standalone Railway worker is in standby; Vercel is the primary scheduler. Set CRIKORA_WORKER_ENABLED=true only during a Vercel deployment fallback.");
    while (!stopped.value) {
      await new Promise(resolve => setTimeout(resolve, 60_000));
    }
    log("Standby worker stopped.");
    return;
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 5_000,
    application_name: "crikora-standalone-worker"
  });
  const leaseToken = randomUUID();
  let leaseOwned = false;

  process.once("SIGINT", () => {
    stopped.value = true;
    log("Shutdown requested (Ctrl+C). Finishing current request.");
  });
  process.once("SIGTERM", () => {
    stopped.value = true;
    log("Termination requested. Finishing current request.");
  });

  try {
    await pool.query("SELECT 1");
    let waitingForLease = false;
    while (!leaseOwned && !stopped.value) {
      leaseOwned = await acquireLease(pool, leaseToken, config.leaseSeconds);
      if (!leaseOwned) {
        if (!waitingForLease) {
          log("A previous Crikora worker still owns the Neon lease; waiting for it to release or expire.");
          waitingForLease = true;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(10, config.idlePollSeconds) * 1000));
      }
    }
    if (!leaseOwned) {
      log("Shutdown requested before the worker could acquire the Neon lease.");
      return;
    }
    log("Crikora standalone worker started.", {
      apiBaseUrl: config.apiBaseUrl,
      refreshCadenceSeconds: "read from Neon settings",
      sourceRequestSpacingMs: process.env.CRICBUZZ_MIN_REQUEST_INTERVAL_MS ?? "1000 (API default)"
    });

    const startFullCrawlOnEnable = config.startFullCrawlOnEnable || args.has("--start-crawl");
    let loggedDisabled = false;
    let targetedStartRequested = false;

    do {
      if (stopped.value) break;
      if (!await renewLease(pool, leaseToken, config.leaseSeconds)) {
        throw new Error("Worker lease expired or was acquired by another process.");
      }

      const settings = await readSettings(config);
      if (!settings.enabled) {
        if (!loggedDisabled) {
          log("Crawler is disabled in Neon/API settings; worker is idle and will make no Cricbuzz requests.");
          loggedDisabled = true;
        }
        if (args.has("--once")) break;
        if (!await waitWithLease(pool, leaseToken, config.leaseSeconds, config.idlePollSeconds)) break;
        continue;
      }
      loggedDisabled = false;

      if (startFullCrawlOnEnable && !targetedStartRequested) {
        // This idempotent endpoint pauses an older broad run and starts/resumes
        // the new targeted-product run before any worker step can claim legacy URLs.
        await startFullCrawl(config);
        targetedStartRequested = true;
      }
      let crawl = await readCrawlStatus(config);
      let crawlStatus = typeof crawl?.status === "string" ? crawl.status : "idle";
      if (crawlStatus === "paused") {
        log("Full crawl remains paused; check the recorded run error before resuming.");
        break;
      }

      let delaySeconds: number;
      if (crawlStatus === "queued" || crawlStatus === "running") {
        const step = await processCrawlStep(config);
        delaySeconds = step.active ? step.retryAfterSeconds : 1;
      } else {
        const backoff = await runRefresh(config);
        delaySeconds = Math.max(1, backoff || settings.refreshIntervalSeconds);
      }

      if (args.has("--once")) break;
      if (!await waitWithLease(pool, leaseToken, config.leaseSeconds, delaySeconds)) break;
    } while (!stopped.value);
  } finally {
    if (leaseOwned) await releaseLease(pool, leaseToken).catch(error => {
      log("Could not release worker lease cleanly.", error instanceof Error ? error.message : String(error));
    });
    await pool.end();
    log("Crikora standalone worker stopped.");
  }
}

void main().catch(error => {
  const status = error instanceof ApiError ? error.status : undefined;
  log("Crikora standalone worker failed.", {
    status,
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
