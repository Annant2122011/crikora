import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryEntityRepository } from "./memory-entity-repository.js";

describe("MemoryEntityRepository ten-minute retention", () => {
  afterEach(() => vi.useRealTimers());

  it("returns cached JSON before ten minutes and expires it at ten minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T12:00:00.000Z"));
    const repository = new MemoryEntityRepository();
    await repository.upsertMany([{
      entityType: "player",
      sourceId: "11527",
      sourceUrl: "https://www.cricbuzz.com/profiles/11527/paul-walter",
      payload: { name: "Paul Walter", images: [{ url: "https://static.cricbuzz.com/player.jpg" }] },
      fetchedAt: new Date().toISOString()
    }]);

    expect(await repository.get("player", "11527")).toMatchObject({
      sourceId: "11527",
      expiresAt: "2026-11-06T12:10:00.000Z"
    });

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await repository.get("player", "11527")).toBeUndefined();
    expect(await repository.list("player")).toHaveLength(0);
    await repository.close();
  });

  it("physically removes expired entries when cleanup runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T12:00:00.000Z"));
    const repository = new MemoryEntityRepository();
    await repository.upsertMany([{
      entityType: "team",
      sourceId: "2",
      sourceUrl: "https://www.cricbuzz.com/cricket-team/india/2",
      payload: { name: "India" },
      fetchedAt: new Date().toISOString()
    }]);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await repository.cleanupExpired()).toBe(1);
    expect(await repository.list("team")).toHaveLength(0);
    await repository.close();
  });
});
