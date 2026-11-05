import type { Match, MatchEvent } from "../domain/types.js";

export interface CricketRepository {
  getMatch(id: string): Promise<Match | undefined>;
  listMatches(status?: Match["status"]): Promise<Match[]>;
  saveMatch(match: Match): Promise<void>;
  saveEvents(events: MatchEvent[]): Promise<void>;
  listEvents(matchId: string): Promise<MatchEvent[]>;
}

/** Development-only. Data is lost when the process restarts. */
export class MemoryRepository implements CricketRepository {
  private matches = new Map<string, Match>();
  private events = new Map<string, MatchEvent>();
  async getMatch(id: string) { return this.matches.get(id); }
  async listMatches(status?: Match["status"]) {
    return [...this.matches.values()].filter(m => !status || m.status === status);
  }
  async saveMatch(match: Match) { this.matches.set(match.id, structuredClone(match)); }
  async saveEvents(events: MatchEvent[]) {
    for (const event of events) this.events.set(event.sourceEventId, structuredClone(event));
  }
  async listEvents(matchId: string) {
    return [...this.events.values()].filter(e => e.matchId === matchId).sort((a,b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}
