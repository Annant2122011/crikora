import type { Innings, Match, MatchEvent } from "../domain/types.js";

/** Stable, deterministic milestone detection from successive scorecard snapshots. */
export function detectEvents(previous: Match | undefined, current: Match): MatchEvent[] {
  const out: MatchEvent[] = [];
  const oldInnings = new Map((previous?.innings ?? []).map(i => [i.id, i]));
  const now = current.updatedAt;
  for (const innings of current.innings) {
    const before = oldInnings.get(innings.id);
    if (!before) continue; // A baseline snapshot is not evidence of a newly occurring event.
    const oldBatters = new Map(before.batters.map(b => [b.id, b]));
    for (const batter of innings.batters) {
      const prior = oldBatters.get(batter.id);
      if (!prior) continue;
      if (batter.runs > prior.runs) {
        const delta = batter.runs - prior.runs;
        if (delta >= 6 && batter.sixes > prior.sixes) out.push(event(current, innings, "six", batter.name, batter.runs, now));
        else if (delta >= 4 && batter.fours > prior.fours) out.push(event(current, innings, "four", batter.name, batter.runs, now));
      }
      if (prior.runs < 100 && batter.runs >= 100) out.push(event(current, innings, "century", batter.name, batter.runs, now));
      else if (prior.runs < 50 && batter.runs >= 50) out.push(event(current, innings, "fifty", batter.name, batter.runs, now));
      if (!prior.out && batter.out) out.push(event(current, innings, "wicket", batter.name, batter.runs, now));
    }
  }
  return out;
}
function event(match: Match, innings: Innings, type: MatchEvent["type"], player: string, runs: number, at: string): MatchEvent {
  const sourceEventId = [match.id, innings.id, type, player, runs].join(":");
  const labels = { four: "hit a four", six: "hit a six", wicket: "was dismissed", fifty: "reached 50", century: "reached 100", five_wicket_haul: "took five wickets", other: "milestone" };
  return { id: sourceEventId, sourceEventId, matchId: match.id, inningsId: innings.id, type,
    teamName: innings.teamName, playerName: player, summary: `${player} ${labels[type]}`, occurredAt: at };
}
