import { Pool } from "pg";
import { sleep } from "workflow";

export interface CrawlerSettings {
  enabled: boolean;
  refreshIntervalSeconds: 10 | 15 | 20 | 30;
}

interface RefreshOutcome {
  stop: boolean;
  retryAfterSeconds?: number;
  message?: string;
}

function normalizeSettings(value: unknown): CrawlerSettings {
  if (!value || typeof value !== "object") {
    throw new Error("Crawler settings response is not an object.");
  }
  const root = value as { data?: Record<string, unknown> };
  const data = root.data;
  if (!data || typeof data !== "object") {
    throw new Error("Crawler settings response has no data object.");
  }
  const interval = Number(data.refreshIntervalSeconds);
  if (![10, 15, 20, 30].includes(interval)) {
    throw new Error("Crawler settings returned an unsupported refresh interval.");
  }
  if (typeof data.enabled !== "boolean") {
    throw new Error("Crawler settings returned an invalid enabled flag.");
  }
  return {
    enabled: data.enabled,
    refreshIntervalSeconds: interval as CrawlerSettings["refreshIntervalSeconds"]
  };
}

async function readSettingsStep(apiBaseUrl: string): Promise<CrawlerSettings> {
  "use step";
  const response = await fetch(new URL("settings", ensureTrailingSlash(apiBaseUrl)), {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Crikora settings endpoint returned HTTP ${response.status}.`);
  }
  return normalizeSettings(await response.json());
}

async function refreshStep(apiBaseUrl: string): Promise<RefreshOutcome> {
  "use step";
  const response = await fetch(new URL("refresh", ensureTrailingSlash(apiBaseUrl)), {
    method: "POST",
    headers: {
      authorization: `Bearer ${requiredEnv("CRIKORA_REFRESH_SECRET")}`,
      accept: "application/json"
    },
    cache: "no-store",
    signal: AbortSignal.timeout(65_000)
  });
  const body = await response.json().catch(() => ({})) as {
    collectorDisabled?: boolean;
    retryAfterSeconds?: number;
    error?: string;
  };
  const headerRetry = Number(response.headers.get("retry-after"));
  if (body.collectorDisabled) {
    return { stop: true, message: body.error ?? "The source collector was disabled after a denial." };
  }
  if (response.status === 429) {
    return {
      stop: false,
      retryAfterSeconds: validDelay(body.retryAfterSeconds) ?? validDelay(headerRetry) ?? 30,
      message: body.error
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { stop: true, message: body.error ?? `Refresh endpoint returned HTTP ${response.status}.` };
  }
  if (!response.ok) {
    return {
      stop: false,
      retryAfterSeconds: validDelay(body.retryAfterSeconds) ?? 30,
      message: body.error ?? `Refresh endpoint returned HTTP ${response.status}.`
    };
  }
  return { stop: false };
}

async function renewWorkerLeaseStep(leaseToken: string, leaseSeconds: number): Promise<boolean> {
  "use step";
  const pool = new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
    max: 1,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
    application_name: "crikora-durable-worker"
  });
  try {
    const result = await pool.query(
      `UPDATE public.crikora_worker_state
          SET lease_until = now() + make_interval(secs => $2),
              updated_at = now()
        WHERE id = 1 AND lease_token = $1 AND lease_until > now()
        RETURNING id`,
      [leaseToken, Math.max(60, Math.min(8_000, Math.ceil(leaseSeconds)))]
    );
    return result.rowCount === 1;
  } finally {
    await pool.end();
  }
}

async function releaseWorkerLeaseStep(leaseToken: string): Promise<void> {
  "use step";
  const pool = new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
    max: 1,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
    application_name: "crikora-durable-worker"
  });
  try {
    await pool.query(
      `UPDATE public.crikora_worker_state
          SET lease_until = NULL, lease_token = NULL, updated_at = now()
        WHERE id = 1 AND lease_token = $1`,
      [leaseToken]
    );
  } finally {
    await pool.end();
  }
}

/**
 * Durable recurring workflow. The API owns scraping and Neon cache writes;
 * this workflow only schedules calls and sleeps between them.
 */
export async function crikoraRefreshLoop(
  apiBaseUrl: string,
  leaseToken: string
): Promise<{ status: "stopped" | "disabled" | "lease-lost"; message?: string }> {
  "use workflow";
  try {
    while (true) {
      const settings = await readSettingsStep(apiBaseUrl);
      if (!settings.enabled) {
        return { status: "disabled" };
      }

      const ownsLease = await renewWorkerLeaseStep(leaseToken, 120);
      if (!ownsLease) {
        return { status: "lease-lost" };
      }

      const cycleStartedAt = Date.now();
      const outcome = await refreshStep(apiBaseUrl);
      if (outcome.stop) {
        return { status: "stopped", message: outcome.message };
      }

      const latestSettings = await readSettingsStep(apiBaseUrl);
      if (!latestSettings.enabled) {
        return { status: "disabled" };
      }

      const configuredDelay = latestSettings.refreshIntervalSeconds -
        Math.floor((Date.now() - cycleStartedAt) / 1000);
      const waitSeconds = Math.max(
        1,
        Math.min(7_200, outcome.retryAfterSeconds ?? configuredDelay)
      );
      const leaseSeconds = waitSeconds + 120;
      const renewed = await renewWorkerLeaseStep(leaseToken, leaseSeconds);
      if (!renewed) {
        return { status: "lease-lost" };
      }
      await sleep(`${waitSeconds}s`);
    }
  } finally {
    await releaseWorkerLeaseStep(leaseToken);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function validDelay(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 1) return undefined;
  return Math.min(7_200, Math.ceil(value));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
