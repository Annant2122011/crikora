import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryEntityRepository } from "./memory-entity-repository.js";
import type { CrikoraEntity } from "../domain/entities.js";

const now = "2026-11-06T12:00:00.000Z";
function entity(
  entityType: CrikoraEntity["entityType"],
  sourceId: string,
  payload: Record<string, unknown>
): CrikoraEntity {
  return {
    entityType,
    sourceId,
    sourceUrl: `https://www.cricbuzz.com/test/${sourceId}`,
    payload,
    fetchedAt: new Date().toISOString()
  };
}

describe("MemoryEntityRepository classified retention", () => {
  afterEach(() => vi.useRealTimers());

  it("expires live match scores after ten minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const repository = new MemoryEntityRepository();
    await repository.upsertMany([entity("match", "live-1", { status: "live", score: "120/3" })]);

    expect(await repository.get("match", "live-1")).toMatchObject({
      retentionClass: "ephemeral",
      expiresAt: "2026-11-06T12:10:00.000Z"
    });
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await repository.get("match", "live-1")).toBeUndefined();
    await repository.close();
  });

  it("retains upcoming fixtures without expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const repository = new MemoryEntityRepository();
    await repository.upsertMany([entity("match", "fixture-1", { status: "upcoming", homeTeam: "India", awayTeam: "New Zealand" })]);

    expect(await repository.get("match", "fixture-1")).toMatchObject({
      retentionClass: "persistent",
      expiresAt: null
    });
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    expect(await repository.get("match", "fixture-1")).toMatchObject({ sourceId: "fixture-1" });
    await repository.close();
  });

  it("keeps stable profiles and editorial content until refreshed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const repository = new MemoryEntityRepository();
    await repository.upsertMany([
      entity("player", "11527", { name: "Player profile" }),
      entity("metadata", "news:1", { pageKind: "news", title: "News" })
    ]);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(await repository.get("player", "11527")).toMatchObject({ retentionClass: "persistent", expiresAt: null });
    expect(await repository.get("metadata", "news:1")).toMatchObject({ retentionClass: "persistent", expiresAt: null });
    await repository.close();
  });

  it("expires player statistics and live analysis pages after ten minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const repository = new MemoryEntityRepository();
    await repository.upsertMany([
      entity("metadata", "player-stats:1", { pageKind: "player-stats" }),
      entity("metadata", "commentary:1", { pageKind: "commentary" }),
      entity("ranking", "men-test-batting", { category: "batting" })
    ]);
    expect(await repository.list("metadata")).toHaveLength(2);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await repository.list("metadata")).toHaveLength(0);
    expect(await repository.list("ranking")).toHaveLength(0);
    await repository.close();
  });

  it("promotes a completed match from volatile to persistent on refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const repository = new MemoryEntityRepository();
    await repository.upsertMany([entity("match", "match-2", { status: "live", score: "120/3" })]);
    await repository.upsertMany([entity("match", "match-2", { status: "completed", result: "India won" })]);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(await repository.get("match", "match-2")).toMatchObject({
      retentionClass: "persistent",
      expiresAt: null,
      payload: { status: "completed", result: "India won" }
    });
    await repository.close();
  });
});
