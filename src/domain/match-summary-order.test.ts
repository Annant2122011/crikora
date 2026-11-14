import { describe, expect, it } from "vitest";
import { toCompactMatchPayload } from "./match-summary.js";

describe("historical innings order", () => {
  it("uses the score appearance order when the second-listed team bats first", () => {
    const summary = toCompactMatchPayload({
      entityType: "match",
      sourceId: "128",
      sourceUrl: "https://www.cricbuzz.com/live-cricket-scores/128/england-vs-south-africa",
      fetchedAt: "2026-11-14T12:00:00.000Z",
      payload: {
        status: "completed",
        homeTeam: "England",
        awayTeam: "South Africa",
        stats: {
          liveSummary: "England vs South Africa T20. South Africa was all out for 190 runs in 19.3 overs. England 191/3 (19.4 Ov)."
        }
      }
    });

    expect(summary.innings).toEqual([
      { inningsNumber: 1, teamName: "South Africa", runs: 190, wickets: 10, overs: "19.3", allOut: true, declared: false },
      { inningsNumber: 2, teamName: "England", runs: 191, wickets: 3, overs: "19.4", allOut: false, declared: false }
    ]);
  });
});
