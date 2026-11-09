import { randomUUID, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { Hono } from "hono";
import { start } from "workflow/api";
import { crikoraRefreshLoop } from "./workflows/refresh-loop.js";

const app = new Hono();
const INTERVALS = [10, 15, 20, 30] as const;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(header: string | undefined): boolean {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  return safeEqual(token, env("CRIKORA_WORKER_ADMIN_SECRET"));
}

function apiUrl(path: string): URL {
  const base = env("CRIKORA_API_BASE_URL");
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);
}

async function coreSettings(): Promise<Record<string, unknown>> {
  const response = await fetch(apiUrl("settings"), {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Crikora API settings returned HTTP ${response.status}.`);
  return await response.json() as Record<string, unknown>;
}

async function updateCoreSettings(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(apiUrl("settings"), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${env("CRIKORA_ADMIN_SECRET")}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(
    typeof data.error === "string" ? data.error : `Crikora API settings returned HTTP ${response.status}.`
  );
  return data;
}

async function startLoop(): Promise<{ started: boolean; reason?: string }> {
  const settings = await coreSettings();
  const data = settings.data as Record<string, unknown> | undefined;
  if (!data || data.enabled !== true) return { started: false, reason: "Crawler is disabled." };

  const databaseUrl = env("DATABASE_URL");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
    application_name: "crikora-worker-start"
  });
  const leaseToken = randomUUID();
  let claimed = false;
  try {
    const lock = await pool.query(
      `UPDATE public.crikora_worker_state
          SET lease_token = $1,
              lease_until = now() + interval '120 seconds',
              updated_at = now()
        WHERE id = 1 AND (lease_until IS NULL OR lease_until <= now())
        RETURNING id`,
      [leaseToken]
    );
    claimed = lock.rowCount === 1;
  } finally {
    await pool.end();
  }
  if (!claimed) return { started: false, reason: "A durable refresh workflow already owns the worker lease." };

  try {
    await start(crikoraRefreshLoop, [
      env("CRIKORA_API_BASE_URL"),
      leaseToken
    ]);
    return { started: true };
  } catch (error) {
    const release = new Pool({ connectionString: databaseUrl, max: 1, allowExitOnIdle: true });
    try {
      await release.query(
        `UPDATE public.crikora_worker_state
            SET lease_until = NULL, lease_token = NULL, updated_at = now()
          WHERE id = 1 AND lease_token = $1`,
        [leaseToken]
      );
    } finally {
      await release.end();
    }
    throw error;
  }
}

app.get("/health", async c => c.json({
  ok: true,
  service: "crikora-durable-worker",
  scheduler: "vercel-workflow",
  refreshIntervalsSeconds: INTERVALS
}));

app.get("/v1/settings", async c => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
  try {
    return c.json(await coreSettings());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to read settings." }, 502);
  }
});

app.put("/v1/settings", async c => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.refreshIntervalSeconds !== undefined &&
      !INTERVALS.includes(Number(body.refreshIntervalSeconds) as typeof INTERVALS[number])) {
    return c.json({ error: "refreshIntervalSeconds must be 10, 15, 20 or 30." }, 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean." }, 400);
  }
  try {
    const settings = await updateCoreSettings(body);
    if (body.enabled === true) {
      const result = await startLoop();
      return c.json({ settings, worker: result }, result.started ? 202 : 200);
    }
    return c.json({ settings });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to update settings." }, 502);
  }
});

app.post("/v1/crawl/start", async c => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
  try {
    const response = await fetch(apiUrl("crawl/start"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env("CRIKORA_ADMIN_SECRET")}`,
        accept: "application/json"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    const crawl = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      return c.json({ error: typeof crawl.error === "string" ? crawl.error : `Crikora crawl start returned HTTP ${response.status}.`, details: crawl }, response.status as 400);
    }
    const worker = await startLoop();
    return c.json({ ok: true, crawl, worker }, worker.started ? 202 : 200);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to start the full crawl." }, 502);
  }
});

app.post("/v1/loop/start", async c => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
  try {
    const result = await startLoop();
    return c.json(result, result.started ? 202 : 409);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to start crawler workflow." }, 502);
  }
});

app.post("/v1/loop/stop", async c => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
  try {
    const settings = await updateCoreSettings({ enabled: false });
    return c.json({
      ok: true,
      status: "stopping",
      message: "The durable loop exits after its current refresh or next settings check.",
      settings
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to stop crawler workflow." }, 502);
  }
});

export default app;
