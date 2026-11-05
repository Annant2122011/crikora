import type { CricketProvider } from "./provider.js";
import type { ProviderSnapshot } from "../domain/types.js";

/** Synthetic data only. Never presented as real-world live scores. */
export class DemoProvider implements CricketProvider {
  readonly id = "demo";
  async fetchSnapshot(): Promise<ProviderSnapshot> {
    const now = new Date().toISOString();
    return {
      fetchedAt: now,
      matches: [{
        id: "demo-match-001", source: "demo", sourceMatchId: "demo-match-001",
        competition: "Crikora Demo Cup", homeTeam: "Harbour Hawks", awayTeam: "Valley Vipers",
        status: "live", format: "T20", startTime: now, venue: "Demo Ground",
        description: "Synthetic development fixture", updatedAt: now,
        innings: [{
          id: "demo-innings-1", teamId: "harbour-hawks", teamName: "Harbour Hawks",
          runs: 87, wickets: 2, overs: "10.4",
          batters: [
            { id: "demo-batter-1", name: "A. Example", runs: 51, balls: 32, fours: 5, sixes: 2, out: false },
            { id: "demo-batter-2", name: "B. Sample", runs: 18, balls: 14, fours: 2, sixes: 0, out: false }
          ],
          bowlers: [{ id: "demo-bowler-1", name: "C. Placeholder", overs: "2.4", runs: 21, wickets: 1 }]
        }]
      }],
      events: []
    };
  }
}
