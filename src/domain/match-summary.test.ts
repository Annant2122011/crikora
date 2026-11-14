import { describe, expect, it } from "vitest";
import { toCompactMatchPayload } from "./match-summary.js";

describe("toCompactMatchPayload", () => {
  it("keeps only match-card score and toss fields", () => {
    const summary = toCompactMatchPayload({
      entityType: "match",
      sourceId: "123",
      sourceUrl: "https://www.cricbuzz.com/live-cricket-scores/123/england-vs-south-africa",
      fetchedAt: "2026-11-14T12:00:00.000Z",
      payload: {
        status: "completed",
        competition: "International",
        format: "T20",
        homeTeam: "England",
        awayTeam: "South Africa",
        toss: "England won the toss and chose to bowl",
        result: "England won by 7 wickets",
        innings: [
          { inningsNumber: 1, teamName: "South Africa", runs: 190, wickets: 10, overs: "19.3", batters: [{ name: "Do not store" }] },
          { inningsNumber: 2, teamName: "England", runs: 191, wickets: 3, overs: "19.4", bowlers: [{ name: "Do not store" }] }
        ],
        matchData: { deliveries: [{ commentary: "Do not store" }], commentary: [{ commentary: "Do not store" }] },
        officials: { umpire: "Do not store" },
        squads: { players: ["Do not store"] },
        stats: { scorecardText: "Do not store" }
      }
    });

    expect(summary).toMatchObject({
      status: "completed",
      tossWinner: "England",
      tossDecision: "bowl",
      winner: "England",
      victoryMargin: "7 wickets",
      innings: [
        { teamName: "South Africa", runs: 190, wickets: 10, overs: "19.3", allOut: true },
        { teamName: "England", runs: 191, wickets: 3, overs: "19.4", allOut: false }
      ]
    });
    expect(JSON.stringify(summary)).not.toContain("Do not store");
  });

  it("derives scores from short index-card text when structured innings are unavailable", () => {
    const summary = toCompactMatchPayload({
      entityType: "match",
      sourceId: "124",
      sourceUrl: "https://www.cricbuzz.com/live-cricket-scores/124/england-vs-south-africa",
      fetchedAt: "2026-11-14T12:00:00.000Z",
      payload: {
        status: "completed",
        homeTeam: "South Africa",
        awayTeam: "England",
        stats: { indexCardText: "South Africa 190 all out in 19.3 overs; England 191/3 (19.4 Ov)" }
      }
    });
    expect(summary.innings).toEqual([
      { inningsNumber: 1, teamName: "South Africa", runs: 190, wickets: 10, overs: "19.3", allOut: true, declared: false },
      { inningsNumber: 2, teamName: "England", runs: 191, wickets: 3, overs: "19.4", allOut: false, declared: false }
    ]);
  });
  it("extracts final innings totals from the compact facts text without scorecard data", () => {
    const summary = toCompactMatchPayload({
      entityType: "match",
      sourceId: "127",
      sourceUrl: "https://www.cricbuzz.com/live-cricket-scores/127/south-africa-vs-england",
      fetchedAt: "2026-11-14T12:00:00.000Z",
      payload: {
        status: "completed",
        homeTeam: "South Africa",
        awayTeam: "England",
        toss: "England chose to bowl",
        result: "England won by 7 wickets",
        stats: {
          liveSummary: "South Africa 190 all out in 19.3 overs; England 191/3 (19.4 Ov); England won by 7 wickets",
          infoText: "Toss: England chose to bowl; Venue: Newlands"
        }
      }
    });
    expect(summary).toMatchObject({
      tossWinner: "England",
      tossDecision: "bowl",
      winner: "England",
      victoryMargin: "7 wickets",
      innings: [
        { teamName: "South Africa", runs: 190, wickets: 10, overs: "19.3", allOut: true },
        { teamName: "England", runs: 191, wickets: 3, overs: "19.4", allOut: false }
      ]
    });
  });

  it("does not interpret overs as wickets and parses tosses without a redundant won-the-toss phrase", () => {
    const summary = toCompactMatchPayload({
      entityType: "match",
      sourceId: "125",
      sourceUrl: "https://www.cricbuzz.com/live-cricket-scores/125/england-vs-south-africa",
      fetchedAt: "2026-11-14T12:00:00.000Z",
      payload: {
        status: "completed",
        homeTeam: "South Africa",
        awayTeam: "England",
        toss: "England chose to bowl",
        stats: { indexCardText: "South Africa 190 (19.3 Ov); England 191/3 (19.4 Ov)" }
      }
    });
    expect(summary.tossWinner).toBe("England");
    expect(summary.tossDecision).toBe("bowl");
    expect(summary.innings).toMatchObject([
      { teamName: "South Africa", runs: 190, wickets: null, overs: "19.3", allOut: false },
      { teamName: "England", runs: 191, wickets: 3, overs: "19.4", allOut: false }
    ]);
  });
  it("derives compact totals from completed scorecard text without keeping detailed tables", () => {
    const summary = toCompactMatchPayload({
      entityType: "match",
      sourceId: "126",
      sourceUrl: "https://www.cricbuzz.com/live-cricket-scores/126/england-vs-south-africa",
      fetchedAt: "2026-11-14T12:00:00.000Z",
      payload: {
        status: "completed",
        homeTeam: "South Africa",
        awayTeam: "England",
        stats: {
          scorecardText: "South Africa 190 all out in 19.3 overs; England 191/3 (19.4 Ov)"
        },
        scorecardPage: { tables: [{ rows: [{ batter: "Do not persist" }] }] }
      }
    });
    expect(summary.innings).toMatchObject([
      { teamName: "South Africa", runs: 190, wickets: 10, overs: "19.3", allOut: true },
      { teamName: "England", runs: 191, wickets: 3, overs: "19.4", allOut: false }
    ]);
    expect(JSON.stringify(summary)).not.toContain("Do not persist");
  });
});
