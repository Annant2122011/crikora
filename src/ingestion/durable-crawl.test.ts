import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { CricbuzzProvider } from "../providers/cricbuzz-provider.js";
import { MemoryEntityRepository } from "../storage/memory-entity-repository.js";
import { DurableCrawlService } from "./durable-crawl.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const PAGE_URL = "https://www.cricbuzz.com/cricket-news/140765/sample-story";

function makeProvider(): CricbuzzProvider {
  return new CricbuzzProvider({
    minRequestIntervalMs: 0,
    maxMatchesPerPoll: 2,
    maxProfilesPerPoll: 1,
    maxTeamsPerPoll: 1,
    maxSeriesPerPoll: 1,
    maxVenuesPerPoll: 1,
    maxContentPagesPerPoll: 1,
    timeoutMs: 1_000,
    maxResponseBytes: 100_000,
    userAgent: "Crikora test suite"
  });
}

describe("DurableCrawlService page-level failure isolation", () => {
  it("marks a challenged page skipped and completes the run instead of pausing it", async () => {
    const provider = makeProvider();
    const fetchPage = vi.spyOn(provider, "fetchCrawlPage").mockResolvedValue({
      discoveredUrls: [],
      skipped: true
    });
    const updates: Array<{ sql: string; values: unknown[] }> = [];
    let queueCountsRead = 0;

    const pool = {
      async query(sql: string, values: unknown[] = []) {
        if (sql.includes("SELECT id, status FROM public.crikora_crawl_runs WHERE status IN")) {
          return { rows: [{ id: RUN_ID, status: "running" }], rowCount: 1 };
        }
        if (sql.includes("WITH candidates AS")) {
          return {
            rows: [{ id: 7, canonical_url: PAGE_URL, attempts: 1 }],
            rowCount: 1
          };
        }
        if (sql.includes("SELECT * FROM public.crikora_crawl_runs WHERE id = $1")) {
          return {
            rows: [{
              id: RUN_ID,
              status: "running",
              seeded_url_count: 1,
              discovered_url_count: 1,
              failed_count: 0,
              skipped_count: 1,
              last_error: null,
              created_at: new Date("2026-11-10T00:00:00.000Z"),
              started_at: new Date("2026-11-10T00:00:00.000Z"),
              completed_at: null
            }],
            rowCount: 1
          };
        }
        if (sql.includes("SELECT count(*) AS total_count")) {
          queueCountsRead += 1;
          return {
            rows: [{
              total_count: "1",
              pending_count: "0",
              processing_count: "0",
              completed_count: "0",
              failed_count: "0",
              skipped_count: "1",
              next_attempt_at: null
            }],
            rowCount: 1
          };
        }
        if (sql.includes("UPDATE public.crikora_crawl_queue SET status = $1")) {
          updates.push({ sql, values });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE public.crikora_crawl_runs SET status = 'completed'")) {
          updates.push({ sql, values });
          return { rows: [], rowCount: 1 };
        }
        updates.push({ sql, values });
        return { rows: [], rowCount: 0 };
      }
    } as unknown as Pool;

    const repository = new MemoryEntityRepository();
    try {
      const service = new DurableCrawlService(pool, provider, repository, 1, 4, 75);
      const result = await service.processBatch();

      expect(fetchPage).toHaveBeenCalledWith(PAGE_URL, undefined);
      expect(result.status).toBe("completed");
      expect(result.active).toBe(false);
      expect(result.processedThisBatch).toBe(1);
      expect(result.run?.skippedCount).toBe(1);
      expect(result.run?.pendingCount).toBe(0);
      expect(updates.some(item => item.values[0] === "skipped")).toBe(true);
      expect(updates.some(item => item.sql.includes("SET status = 'paused'"))).toBe(false);
      expect(updates.some(item => item.sql.includes("SET enabled = false"))).toBe(false);
      expect(queueCountsRead).toBeGreaterThanOrEqual(2);
    } finally {
      await repository.close();
      vi.restoreAllMocks();
    }
  });
});
