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
  sourceUrl?: string;
  infoUrl?: string;
  scorecardUrl?: string;
  squadsUrl?: string;
  commentaryUrl?: string;
  toss?: string;
  result?: string;
  officials?: Record<string, string>;
  squads?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  images?: Array<{ url: string; alt?: string }>;
  events?: MatchEvent[];
  /** Structured innings, deliveries, extras, partnerships and commentary. */
  matchData?: {
    schemaVersion: number;
    innings: unknown[];
    deliveries: unknown[];
    commentary: unknown[];
    coverage?: {
      scorecard: boolean;
      deliveries: boolean;
      commentary: boolean;
      deliveryCompleteness: "present-unverified" | "not-exposed";
      sources: string[];
    };
  };
}
export interface MatchEvent {
  id: string; matchId: string; inningsId: string; type: EventType;
  teamName: string; playerName?: string; summary: string;
  over?: string; occurredAt: string; sourceEventId: string;
  runs?: number; wickets?: number; dismissal?: string;
}
export interface SourcePageCapture {
  url: string;
  html: string;
  contentType: string;
  fetchedAt: string;
  pageKind: string;
  entityType?: string;
  sourceId?: string;
}

export interface ProviderSnapshot {
  matches: Match[];
  events: MatchEvent[];
  fetchedAt: string;
  entities: import("./entities.js").CrikoraEntity[];
  sourcePages?: SourcePageCapture[];
}
