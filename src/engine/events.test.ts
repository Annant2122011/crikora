import { describe, expect, it } from "vitest";
import { detectMilestoneEvents } from "./events.js";
import type { Match } from "../domain/types.js";

function fixture(runs: number, wickets: number): Match {
  return {
    id: "cricbuzz:123", source: "cricbuzz", sourceMatchId: "123",
    competition: "Test Cup", homeTeam: "Alpha", awayTeam: "Beta",
    status: "live", format: "Test", startTime: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-06T12:00:00.000Z",
    innings: [{
      id: "123:innings:1", teamId: "alpha", teamName: "Alpha",
      runs: 200, wickets: 5, overs: "50.0",
      batters: [{ id: "batter-1", name: "A Player", runs, balls: 150, fours: 8, sixes: 1, out: false }],
      bowlers: [{ id: "bowler-1", name: "B Bowler", overs: "20.0", runs: 60, wickets }]
    }]
  };
}

describe("safe scorecard milestone detection", () => {
  it("emits a fifty or century only when the batter crosses the threshold", () => {
    expect(detectMilestoneEvents(fixture(49, 3), fixture(50, 3)).map(event => event.type)).toEqual(["fifty"]);
    expect(detectMilestoneEvents(fixture(99, 3), fixture(100, 3)).map(event => event.type)).toEqual(["century"]);
  });

  it("emits a five-wicket haul once, not on every subsequent snapshot", () => {
    expect(detectMilestoneEvents(fixture(20, 4), fixture(20, 5)).map(event => event.type)).toEqual(["five_wicket_haul"]);
    expect(detectMilestoneEvents(fixture(20, 5), fixture(20, 6))).toEqual([]);
  });

  it("does not infer events from a baseline snapshot", () => {
    expect(detectMilestoneEvents(undefined, fixture(100, 5))).toEqual([]);
  });
});
