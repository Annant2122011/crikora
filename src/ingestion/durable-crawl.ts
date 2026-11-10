import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { EntityRepository } from "../domain/entities.js";
import { isArchiveRepository } from "../storage/archive-repository.js";
import { dedupeCricbuzzPageUrls, getCricbuzzCrawlIdentityKey, type CricbuzzProvider } from "../providers/cricbuzz-provider.js";

type RunStatus = "queued" | "running" | "completed" | "paused";
type QueueStatus = "pending" | "processing" | "completed" | "failed" | "skipped";

interface RunRow {
  id: string;
  status: RunStatus;
  seeded_url_count: number;
  discovered_url_count: number;
  processed_count: number;
  failed_count: number;
  skipped_count: number;
  last_error: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

interface QueueRow {
  id: string | number;
  canonical_url: string;
  attempts: number;
}

interface QueueCounts {
  total_count: string | number;
  pending_count: string | number;
  processing_count: string | number;
  completed_count: string | number;
  failed_count: string | number;
  skipped_count: string | number;
  next_attempt_at: Date | string | null;
}

export interface CrawlRunSummary {
  runId: string;
  status: RunStatus;
  seededUrlCount: number;
  discoveredUrlCount: number;
  processedCount: number;
  failedCount: number;
  skippedCount: number;
  pendingCount: number;
  processingCount: number;
  totalCount: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CrawlStepResult {
  active: boolean;
  status: "idle" | RunStatus;
  processedThisBatch: number;
  retryAfterSeconds?: number;
  run?: CrawlRunSummary;
}

function count(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sourceStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("sourceStatus" in error)) return undefined;
  const value = Number((error as { sourceStatus?: unknown }).sourceStatus);
  return Number.isInteger(value) ? value : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("retryAfterMs" in error)) return undefined;
  const value = Number((error as { retryAfterMs?: unknown }).retryAfterMs);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function pageKind(url: string): string {
  try {
    const path = new URL(url).pathname.split("/").filter(Boolean);
    return path[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export class DurableCrawlService {
  constructor(
    private readonly pool: Pool,
    private readonly provider: CricbuzzProvider,
    private readonly repository: EntityRepository,
    private readonly batchSize = 2,
    private readonly maxAttempts = 4,
    private readonly leaseSeconds = 75
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 3) {
      throw new RangeError("CRIKORA_CRAWL_BATCH_SIZE must be 1, 2 or 3.");
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
      throw new RangeError("CRIKORA_CRAWL_MAX_ATTEMPTS must be between 1 and 8.");
    }
  }

  async startFullCrawl(seedUrls: string[]): Promise<{ created: boolean; resumed: boolean; run: CrawlRunSummary }> {
    const urls = dedupeCricbuzzPageUrls(seedUrls.filter(url => this.provider.isAllowedCrawlUrl(url)));
    const identityKeys = urls.map(getCricbuzzCrawlIdentityKey);
    if (!urls.length) throw new Error("The sitemap inventory contains no URLs accepted by the Cricbuzz page allowlist.");
    await this.recordCoverageTargets(urls);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('crikora_full_crawl'))");

      const active = await client.query<RunRow>(
        "SELECT * FROM public.crikora_crawl_runs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1 FOR UPDATE"
      );
      if (active.rows[0]) {
        const runId = active.rows[0].id;
        await this.skipOutOfScopeJobs(client, runId);
        const inserted = await client.query(
          "INSERT INTO public.crikora_crawl_queue (run_id, canonical_url, identity_key, page_kind, discovered_from) SELECT $1, item.canonical_url, item.identity_key, $4, 'sitemap' FROM unnest($2::text[], $3::text[]) AS item(canonical_url, identity_key) ON CONFLICT DO NOTHING",
          [runId, urls, identityKeys, "sitemap"]
        );
        if (inserted.rowCount) {
          await client.query(
            "UPDATE public.crikora_crawl_runs SET discovered_url_count = discovered_url_count + $2 WHERE id = $1",
            [runId, inserted.rowCount]
          );
        }
        await client.query("COMMIT");
        const summary = await this.readSummary(runId);
        return { created: false, resumed: false, run: summary };
      }

      const paused = await client.query<RunRow>(
        "SELECT * FROM public.crikora_crawl_runs WHERE status = 'paused' ORDER BY created_at DESC LIMIT 1 FOR UPDATE"
      );
      if (paused.rows[0]) {
        const runId = paused.rows[0].id;
        await this.skipOutOfScopeJobs(client, runId);
        const inserted = await client.query(
          "INSERT INTO public.crikora_crawl_queue (run_id, canonical_url, identity_key, page_kind, discovered_from) SELECT $1, item.canonical_url, item.identity_key, $4, 'sitemap' FROM unnest($2::text[], $3::text[]) AS item(canonical_url, identity_key) ON CONFLICT DO NOTHING",
          [runId, urls, identityKeys, "sitemap"]
        );
        if (inserted.rowCount) {
          await client.query(
            "UPDATE public.crikora_crawl_runs SET discovered_url_count = discovered_url_count + $2 WHERE id = $1",
            [runId, inserted.rowCount]
          );
        }
        await client.query(
          "UPDATE public.crikora_crawl_runs SET status = 'running', last_error = NULL, completed_at = NULL WHERE id = $1",
          [runId]
        );
        await client.query(
          "UPDATE public.crikora_crawl_queue SET status = 'pending', lease_token = NULL, lease_until = NULL, next_attempt_at = now(), updated_at = now() WHERE run_id = $1 AND status = 'processing'",
          [runId]
        );
        await client.query(
          "UPDATE public.crikora_crawler_settings SET enabled = true, last_error = NULL, lease_until = NULL, updated_at = now() WHERE id = 1"
        );
        await client.query("COMMIT");
        const summary = await this.readSummary(runId);
        return { created: false, resumed: true, run: summary };
      }

      const runId = randomUUID();
      await client.query(
        "INSERT INTO public.crikora_crawl_runs (id, status, seeded_url_count, discovered_url_count, created_at, started_at) VALUES ($1, 'queued', $2, $2, now(), now())",
        [runId, urls.length]
      );
      await client.query(
        "INSERT INTO public.crikora_crawl_queue (run_id, canonical_url, identity_key, page_kind, discovered_from) SELECT $1, item.canonical_url, item.identity_key, $4, 'sitemap' FROM unnest($2::text[], $3::text[]) AS item(canonical_url, identity_key) ON CONFLICT DO NOTHING",
        [runId, urls, identityKeys, "sitemap"]
      );
      await client.query(
        "UPDATE public.crikora_crawl_runs SET status = 'running' WHERE id = $1",
        [runId]
      );
      await client.query(
        "UPDATE public.crikora_crawler_settings SET enabled = true, last_error = NULL, lease_until = NULL, updated_at = now() WHERE id = 1"
      );
      await client.query("COMMIT");
      const summary = await this.readSummary(runId);
      return { created: true, resumed: false, run: summary };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }


  private async recordCoverageTargets(urls: string[]): Promise<void> {
    if (!urls.length) return;
    const identityKeys = urls.map(getCricbuzzCrawlIdentityKey);
    const kinds = urls.map(pageKind);
    await this.pool.query(
      `INSERT INTO public.crikora_archive_coverage
        (source_url, identity_key, page_kind, status)
       SELECT item.source_url, item.identity_key, item.page_kind, 'pending'
       FROM unnest($1::text[], $2::text[], $3::text[]) AS item(source_url, identity_key, page_kind)
       ON CONFLICT (source_url) DO UPDATE SET
         identity_key = EXCLUDED.identity_key,
         page_kind = EXCLUDED.page_kind,
         status = CASE WHEN public.crikora_archive_coverage.status = 'captured' THEN 'captured' ELSE 'pending' END,
         last_discovered_at = now(), updated_at = now()`,
      [urls, identityKeys, kinds]
    );
  }

  private async skipOutOfScopeJobs(client: PoolClient, runId: string): Promise<number> {
    const queued = await client.query<{ id: string; canonical_url: string }>(
      "SELECT id, canonical_url FROM public.crikora_crawl_queue WHERE run_id = $1 AND status IN ('pending','processing')",
      [runId]
    );
    const ids = queued.rows
      .filter(row => !this.provider.isAllowedCrawlUrl(row.canonical_url))
      .map(row => String(row.id));
    if (!ids.length) return 0;
    const result = await client.query(
      "UPDATE public.crikora_crawl_queue SET status = 'skipped', lease_token = NULL, lease_until = NULL, completed_at = COALESCE(completed_at, now()), last_error = $1, updated_at = now() WHERE run_id = $2 AND id = ANY($3::bigint[]) AND status IN ('pending','processing')",
      ["Skipped because the URL is outside Crikora's cricket-data scope.", runId, ids]
    );
    return result.rowCount ?? 0;
  }

  async getLatestStatus(): Promise<CrawlRunSummary | undefined> {
    const result = await this.pool.query<RunRow>(
      "SELECT * FROM public.crikora_crawl_runs ORDER BY created_at DESC LIMIT 1"
    );
    const row = result.rows[0];
    return row ? this.readSummary(row.id) : undefined;
  }

  async enqueueDiscoveredUrls(values: string[]): Promise<number> {
    const urls = dedupeCricbuzzPageUrls(values.filter(url => this.provider.isAllowedCrawlUrl(url)));
    const identityKeys = urls.map(getCricbuzzCrawlIdentityKey);
    if (!urls.length) return 0;
    await this.recordCoverageTargets(urls);
    const latest = await this.pool.query<{ id: string; status: RunStatus }>(
      "SELECT id, status FROM public.crikora_crawl_runs ORDER BY created_at DESC LIMIT 1"
    );
    const run = latest.rows[0];
    if (!run || run.status === "paused") return 0;
    const inserted = await this.pool.query(
      "INSERT INTO public.crikora_crawl_queue (run_id, canonical_url, identity_key, page_kind, discovered_from) SELECT $1, item.canonical_url, item.identity_key, $4, 'live-index' FROM unnest($2::text[], $3::text[]) AS item(canonical_url, identity_key) ON CONFLICT DO NOTHING",
      [run.id, urls, identityKeys, "discovered"]
    );
    const added = inserted.rowCount ?? 0;
    if (added) {
      await this.pool.query(
        "UPDATE public.crikora_crawl_runs SET status = CASE WHEN status = 'completed' THEN 'running' ELSE status END, completed_at = NULL, discovered_url_count = discovered_url_count + $2 WHERE id = $1",
        [run.id, added]
      );
    }
    return added;
  }

  async processBatch(signal?: AbortSignal): Promise<CrawlStepResult> {
    const latest = await this.pool.query<{ id: string; status: RunStatus }>(
      "SELECT id, status FROM public.crikora_crawl_runs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1"
    );
    const active = latest.rows[0];
    if (!active) return { active: false, status: "idle", processedThisBatch: 0 };

    await this.pool.query(
      "UPDATE public.crikora_crawl_runs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1 AND status = 'queued'",
      [active.id]
    );

    const leaseToken = randomUUID();
    const claimed = await this.pool.query<QueueRow>(
      "WITH candidates AS (SELECT id FROM public.crikora_crawl_queue WHERE run_id = $1 AND ((status = 'pending' AND next_attempt_at <= now()) OR (status = 'processing' AND lease_until <= now())) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED) UPDATE public.crikora_crawl_queue AS queue SET status = 'processing', attempts = queue.attempts + 1, lease_token = $3, lease_until = now() + make_interval(secs => $4), updated_at = now() FROM candidates WHERE queue.id = candidates.id RETURNING queue.id, queue.canonical_url, queue.attempts",
      [active.id, this.batchSize, leaseToken, this.leaseSeconds]
    );

    if (claimed.rows.length) {
      await this.pool.query(
        `UPDATE public.crikora_archive_coverage
            SET status = 'processing', last_attempted_at = now(),
                attempt_count = attempt_count + 1, updated_at = now()
          WHERE source_url = ANY($1::text[])`,
        [claimed.rows.map(row => row.canonical_url)]
      );
    }

    let processed = 0;
    for (let index = 0; index < claimed.rows.length; index += 1) {
      const row = claimed.rows[index]!;
      if (signal?.aborted) {
        await this.releaseClaimed(active.id, leaseToken);
        throw signal.reason ?? new Error("The durable crawl batch was aborted.");
      }

      try {
        if (!this.provider.isAllowedCrawlUrl(row.canonical_url)) {
          await this.pool.query(
            "UPDATE public.crikora_crawl_queue SET status = 'skipped', lease_token = NULL, lease_until = NULL, completed_at = now(), last_error = $1, updated_at = now() WHERE id = $2 AND run_id = $3 AND lease_token = $4",
            ["Skipped because the URL is outside Crikora's cricket-data scope.", row.id, active.id, leaseToken]
          );
          processed += 1;
          continue;
        }
        const page = await this.provider.fetchCrawlPage(row.canonical_url, signal);
        if (page.sourcePages?.length && isArchiveRepository(this.repository)) {
          await this.repository.recordSourcePages(page.sourcePages, active.id);
        }
        if (page.entity) await this.repository.upsertMany([page.entity]);
        if (page.skipped) {
          await this.pool.query(
            `UPDATE public.crikora_archive_coverage
                SET status = 'skipped', updated_at = now()
              WHERE source_url = $1`,
            [row.canonical_url]
          );
        }
        if (page.discoveredUrls.length) {
          const discovered = dedupeCricbuzzPageUrls(page.discoveredUrls.filter(url => url !== row.canonical_url));
          if (discovered.length) {
            const identityKeys = discovered.map(getCricbuzzCrawlIdentityKey);
            const inserted = await this.pool.query(
              "INSERT INTO public.crikora_crawl_queue (run_id, canonical_url, identity_key, page_kind, discovered_from) SELECT $1, item.canonical_url, item.identity_key, $4, $5 FROM unnest($2::text[], $3::text[]) AS item(canonical_url, identity_key) ON CONFLICT DO NOTHING",
              [active.id, discovered, identityKeys, "discovered", row.canonical_url]
            );
            if (inserted.rowCount) {
              await this.pool.query(
                "UPDATE public.crikora_crawl_runs SET discovered_url_count = discovered_url_count + $2 WHERE id = $1",
                [active.id, inserted.rowCount]
              );
            }
          }
        }
        await this.pool.query(
          "UPDATE public.crikora_crawl_queue SET status = $1, lease_token = NULL, lease_until = NULL, completed_at = now(), last_error = NULL, updated_at = now() WHERE id = $2 AND run_id = $3 AND lease_token = $4",
          [page.skipped ? "skipped" : "completed", row.id, active.id, leaseToken]
        );
        processed += 1;
      } catch (error) {
        const status = sourceStatus(error);
        const message = errorMessage(error);

        if ((status !== undefined && status >= 300 && status < 400) ||
            (status !== undefined && status >= 400 && status < 500 && status !== 429)) {
          await this.pool.query(
            "UPDATE public.crikora_crawl_queue SET status = 'skipped', lease_token = NULL, lease_until = NULL, completed_at = now(), last_error = $1, updated_at = now() WHERE id = $2 AND run_id = $3 AND lease_token = $4",
            [message, row.id, active.id, leaseToken]
          );
          await this.pool.query(
            `INSERT INTO public.crikora_archive_coverage
              (source_url, identity_key, page_kind, status, last_attempted_at, last_http_status, attempt_count, last_error)
             VALUES ($1, $2, $3, 'skipped', now(), $4, $5, $6)
             ON CONFLICT (source_url) DO UPDATE SET
               status = 'skipped', last_attempted_at = now(), last_http_status = EXCLUDED.last_http_status,
               attempt_count = public.crikora_archive_coverage.attempt_count + 1,
               last_error = EXCLUDED.last_error, updated_at = now()`,
            [row.canonical_url, getCricbuzzCrawlIdentityKey(row.canonical_url), pageKind(row.canonical_url), status ?? null, count(row.attempts), message]
          );
          processed += 1;
          console.warn("Crikora skipped one unavailable cricket page and continued the durable run", {
            url: row.canonical_url,
            status: status ?? null,
            message
          });
          continue;
        }

        const attempts = count(row.attempts);
        if (attempts >= this.maxAttempts) {
          await this.pool.query(
            "UPDATE public.crikora_crawl_queue SET status = 'failed', lease_token = NULL, lease_until = NULL, completed_at = now(), last_error = $1, updated_at = now() WHERE id = $2 AND run_id = $3 AND lease_token = $4",
            [message, row.id, active.id, leaseToken]
          );
          await this.pool.query(
            `INSERT INTO public.crikora_archive_coverage
              (source_url, identity_key, page_kind, status, last_attempted_at, last_http_status, attempt_count, last_error)
             VALUES ($1, $2, $3, 'failed', now(), $4, $5, $6)
             ON CONFLICT (source_url) DO UPDATE SET
               status = 'failed', last_attempted_at = now(), last_http_status = EXCLUDED.last_http_status,
               attempt_count = public.crikora_archive_coverage.attempt_count + 1,
               last_error = EXCLUDED.last_error, updated_at = now()`,
            [row.canonical_url, getCricbuzzCrawlIdentityKey(row.canonical_url), pageKind(row.canonical_url), status ?? null, count(row.attempts), message]
          );
          processed += 1;
          continue;
        }

        const suggested = status === 429 ? retryAfterMs(error) : undefined;
        const exponential = Math.min(300_000, 1_000 * (2 ** Math.max(0, attempts - 1)));
        const delayMs = Math.max(1_000, Math.min(3_600_000, suggested ?? (status !== undefined && status >= 500 ? 30_000 : exponential)));
        await this.pool.query(
          "UPDATE public.crikora_crawl_queue SET status = 'pending', next_attempt_at = now() + make_interval(secs => $1::double precision / 1000), lease_token = NULL, lease_until = NULL, last_error = $2, updated_at = now() WHERE id = $3 AND run_id = $4 AND lease_token = $5",
          [delayMs, message, row.id, active.id, leaseToken]
        );
        await this.pool.query(
          `UPDATE public.crikora_archive_coverage
              SET status = 'pending', last_attempted_at = now(), last_http_status = $2,
                  attempt_count = attempt_count + 1, last_error = $3, updated_at = now()
            WHERE source_url = $1`,
          [row.canonical_url, status ?? null, message]
        );
        await this.releaseClaimed(active.id, leaseToken);
        const run = await this.readSummary(active.id);
        return {
          active: true,
          status: "running",
          processedThisBatch: processed,
          retryAfterSeconds: Math.max(1, Math.ceil(delayMs / 1000)),
          run
        };
      }
    }

    await this.repository.cleanupExpired().catch(error => {
      console.warn("Crikora cache cleanup failed during durable crawl batch", error);
    });
    const run = await this.refreshProgress(active.id);
    if (run.status === "completed" || run.status === "paused") {
      return { active: false, status: run.status, processedThisBatch: processed, run };
    }
    let retryAfterSeconds: number | undefined;
    if (run.pendingCount > 0 && run.processingCount === 0) {
      const next = await this.pool.query<{ seconds: number | string | null }>(
        "SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (MIN(next_attempt_at) - now())))) AS seconds FROM public.crikora_crawl_queue WHERE run_id = $1 AND status = 'pending'",
        [active.id]
      );
      retryAfterSeconds = count(next.rows[0]?.seconds) || undefined;
    }
    return { active: true, status: run.status, processedThisBatch: processed, retryAfterSeconds, run };
  }

  private async releaseClaimed(runId: string, leaseToken: string): Promise<void> {
    await this.pool.query(
      "UPDATE public.crikora_crawl_queue SET status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = now() WHERE run_id = $1 AND status = 'processing' AND lease_token = $2",
      [runId, leaseToken]
    );
  }

  private async refreshProgress(runId: string): Promise<CrawlRunSummary> {
    const summary = await this.readSummary(runId);
    if (summary.pendingCount === 0 && summary.processingCount === 0 && summary.status !== "paused") {
      await this.pool.query(
        "UPDATE public.crikora_crawl_runs SET status = 'completed', completed_at = COALESCE(completed_at, now()), last_error = NULL WHERE id = $1 AND status <> 'paused'",
        [runId]
      );
    }
    const final = await this.readSummary(runId);
    return final;
  }

  private async readSummary(runId: string): Promise<CrawlRunSummary> {
    const result = await this.pool.query<RunRow>(
      "SELECT * FROM public.crikora_crawl_runs WHERE id = $1",
      [runId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Crikora crawl run was not found.");
    const counts = await this.pool.query<QueueCounts>(
      "SELECT count(*) AS total_count, count(*) FILTER (WHERE status = 'pending') AS pending_count, count(*) FILTER (WHERE status = 'processing') AS processing_count, count(*) FILTER (WHERE status = 'completed') AS completed_count, count(*) FILTER (WHERE status = 'failed') AS failed_count, count(*) FILTER (WHERE status = 'skipped') AS skipped_count, min(next_attempt_at) FILTER (WHERE status = 'pending') AS next_attempt_at FROM public.crikora_crawl_queue WHERE run_id = $1",
      [runId]
    );
    const c = counts.rows[0]!;
    return {
      runId: row.id,
      status: row.status,
      seededUrlCount: count(row.seeded_url_count),
      discoveredUrlCount: count(row.discovered_url_count),
      processedCount: count(c.completed_count),
      failedCount: count(c.failed_count),
      skippedCount: count(c.skipped_count),
      pendingCount: count(c.pending_count),
      processingCount: count(c.processing_count),
      totalCount: count(c.total_count),
      lastError: row.last_error,
      createdAt: new Date(row.created_at).toISOString(),
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at)
    };
  }
}
