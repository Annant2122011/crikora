export type MatchStatus = "live" | "upcoming" | "completed";
export type EventType = "four" | "six" | "wicket" | "fifty" | "century" | "five_wicket_haul" | "other";

export interface Batter {
  id: string; name: string; runs: number; balls: number; fours: number; sixes: number; out: boolean;
}
export interface Bowler {
  id: string; name: string; overs: string; runs: number; wickets: number;
}
export interface Innings {
  id: string; teamId: string; teamName: string; runs: number; wickets: number;
  overs: string; batters: Batter[]; bowlers: Bowler[];
}
export interface Match {
  id: string; source: string; sourceMatchId: string; competition: string;
  homeTeam: string; awayTeam: string; status: MatchStatus; format: string;
  startTime: string; venue?: string; description?: string; innings: Innings[];
  updatedAt: string;
}
export interface MatchEvent {
  id: string; matchId: string; inningsId: string; type: EventType;
  teamName: string; playerName?: string; summary: string;
  over?: string; occurredAt: string; sourceEventId: string;
}
export interface ProviderSnapshot { matches: Match[]; events: MatchEvent[]; fetchedAt: string; }
