import { describe, expect, it } from "vitest";
import type { CrikoraEntity } from "../domain/entities.js";
import type { Match, ProviderSnapshot } from "../domain/types.js";
import { MemoryEntityRepository } from "../storage/memory-entity-repository.js";
import { Poller } from "./poller.js";
import type { CricketProvider } from "../providers/provider.js";

function makeMatch(detailed: boolean, status: Match["status"]): Match {
  const now = new Date().toISOString();
  return {
    id: "cricbuzz:123",
    source: "cricbuzz",
    sourceMatchId: "123",
    competition: detailed ? "Example Series" : "Cricket",
    homeTeam: "Alpha",
    awayTeam: "Beta",
    status,
    format: detailed ? "T20" : "Unknown",
    startTime: detailed ? "2026-11-06T12:00:00.000Z" : "",
    venue: detailed ? "Example Ground" : undefined,
    description: "Alpha vs Beta",
    innings: detailed ? [{
      id: "123:innings:1",
      teamId: "alpha",
      teamName: "Alpha",
      runs: 145,
      wickets: 4,
      overs: "17.2",
      batters: [{
        id: "batter-1",
        name: "A Player",
        runs: 65,
        balls: 42,
        fours: 7,
        sixes: 2,
        out: false
      }],
      bowlers: [{
        id: "bowler-1",
        name: "B Bowler",
        overs: "3.0",
        runs: 24,
        wickets: 1
      }]
    }] : [],
    updatedAt: now,
    sourceUrl: "https://www.cricbuzz.com/live-cricket-scores/123/example",
    infoUrl: detailed ? "https://www.cricbuzz.com/cricket-match-facts/123/example" : undefined,
    scorecardUrl: detailed ? "https://www.cricbuzz.com/live-cricket-scorecard/123/example" : undefined,
    squadsUrl: detailed ? "https://www.cricbuzz.com/cricket-match-squads/123/example" : undefined,
    commentaryUrl: detailed ? "https://www.cricbuzz.com/live-cricket-full-commentary/123/example" : undefined,
    stats: detailed
      ? { liveSummary: "Alpha 145/4", scorecardText: "A Player 65 (42)", infoText: "Example Ground" }
      : { indexCardText: "Latest live index card" },
    images: detailed ? [{ url: "https://static.cricbuzz.com/example.jpg", alt: "Team" }] : [],
    squads: detailed ? { players: [{ sourceId: "1", name: "A Player" }] } : undefined
  };
}

function snapshot(match: Match): ProviderSnapshot {
  const fetchedAt = new Date().toISOString();
  const entity: CrikoraEntity = {
    entityType: "match",
    sourceId: match.sourceMatchId,
    sourceUrl: match.sourceUrl ?? "https://www.cricbuzz.com/live-cricket-scores/123",
    payload: match as unknown as Record<string, unknown>,
    fetchedAt
  };
  return { matches: [match], events: [], entities: [entity], fetchedAt };
}

describe("Poller refresh interval configuration", () => {
  const provider: CricketProvider = {
    id: "fixture",
    async fetchSnapshot() {
      return { matches: [], events: [], entities: [], fetchedAt: new Date().toISOString() };
    }
  };

  it.each([10, 15, 20, 30])("accepts %i-second refresh intervals", seconds => {
    const poller = new Poller(provider, new MemoryEntityRepository(), 10_000);
    poller.setRefreshIntervalSeconds(seconds);
    expect(poller.refreshIntervalMs).toBe(seconds * 1000);
  });

  it("rejects unapproved interval values rather than silently coercing them", () => {
    const poller = new Poller(provider, new MemoryEntityRepository(), 10_000);
    expect(() => poller.setRefreshIntervalSeconds(5)).toThrow(RangeError);
    expect(() => poller.setRefreshIntervalSeconds(60)).toThrow(RangeError);
  });
});

describe("Poller progressive match enrichment", () => {
  it("keeps detailed fields when a later cycle only rediscovers the index card", async () => {
    let current = snapshot(makeMatch(true, "upcoming"));
    const provider: CricketProvider = {
      id: "fixture",
      async fetchSnapshot() {
        return current;
      }
    };
    const repository = new MemoryEntityRepository();
    const poller = new Poller(provider, repository, 180_000);

    await poller.tick();
    const before = await repository.get("match", "123");
    expect(before?.payload.scorecardUrl).toContain("live-cricket-scorecard");
    expect(before?.payload.innings).toHaveLength(1);

    current = snapshot(makeMatch(false, "live"));
    await poller.tick();

    const after = await repository.get("match", "123");
    expect(after?.payload.status).toBe("live");
    expect(after?.payload.format).toBe("T20");
    expect(after?.payload.startTime).toBe("2026-11-06T12:00:00.000Z");
    expect(after?.payload.infoUrl).toContain("cricket-match-facts");
    expect(after?.payload.scorecardUrl).toContain("live-cricket-scorecard");
    expect(after?.payload.squadsUrl).toContain("cricket-match-squads");
    expect(after?.payload.commentaryUrl).toContain("live-cricket-full-commentary");
    expect(after?.payload.innings).toHaveLength(1);
    expect(after?.payload.images).toHaveLength(1);
    expect(after?.payload.squads).toMatchObject({
      players: [expect.objectContaining({ name: "A Player" })]
    });
    expect(after?.payload.stats).toMatchObject({
      scorecardText: "A Player 65 (42)",
      indexCardText: "Latest live index card"
    });

    await repository.close();
  });
});
