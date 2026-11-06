import type { Innings, Match, MatchEvent } from "../domain/types.js";

/** Detect only scorecard milestones whose crossing can be safely inferred from snapshots. */
export function detectMilestoneEvents(previous: Match | undefined, current: Match): MatchEvent[] {
  if (!previous) return [];
  const out: MatchEvent[] = [];
  const oldInnings = new Map((previous.innings ?? []).map(innings => [innings.id, innings]));
  const occurredAt = current.updatedAt;

  for (const innings of current.innings ?? []) {
    const before = oldInnings.get(innings.id);
    if (!before) continue;

    const oldBatters = new Map((before.batters ?? []).map(batter => [batter.id, batter]));
    for (const batter of innings.batters ?? []) {
      const prior = oldBatters.get(batter.id);
      if (!prior) continue;
      if (prior.runs < 100 && batter.runs >= 100) {
        out.push(makeEvent(current, innings, "century", batter.id, batter.name, batter.runs, occurredAt));
      } else if (prior.runs < 50 && batter.runs >= 50) {
        out.push(makeEvent(current, innings, "fifty", batter.id, batter.name, batter.runs, occurredAt));
      }
    }

    const oldBowlers = new Map((before.bowlers ?? []).map(bowler => [bowler.id, bowler]));
    for (const bowler of innings.bowlers ?? []) {
      const prior = oldBowlers.get(bowler.id);
      if (prior && prior.wickets < 5 && bowler.wickets >= 5) {
        out.push(makeEvent(current, innings, "five_wicket_haul", bowler.id, bowler.name, bowler.wickets, occurredAt));
      }
    }
  }
  return out;
}

function makeEvent(
  match: Match,
  innings: Innings,
  type: MatchEvent["type"],
  subjectId: string,
  playerName: string,
  value: number,
  occurredAt: string
): MatchEvent {
  const labels = {
    fifty: "reached 50",
    century: "reached 100",
    five_wicket_haul: "took five wickets",
    four: "hit a four",
    six: "hit a six",
    wicket: "was dismissed",
    other: "reached a milestone"
  };
  const sourceEventId = [match.id, innings.id, type, subjectId].join(":");
  return {
    id: sourceEventId,
    sourceEventId,
    matchId: match.id,
    inningsId: innings.id,
    type,
    teamName: innings.teamName,
    playerName,
    summary: `${playerName} ${labels[type]}`,
    runs: type === "fifty" || type === "century" ? value : undefined,
    wickets: type === "five_wicket_haul" ? value : undefined,
    occurredAt
  };
}
