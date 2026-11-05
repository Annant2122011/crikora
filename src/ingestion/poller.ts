import type { CricketProvider } from "../providers/provider.js";
import type { CricketRepository } from "../storage/repository.js";
import { detectEvents } from "../engine/events.js";

export class Poller {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private provider: CricketProvider, private repository: CricketRepository, private intervalMs: number) {}
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const snapshot = await this.provider.fetchSnapshot();
      for (const match of snapshot.matches) {
        const previous = await this.repository.getMatch(match.id);
        await this.repository.saveEvents(detectEvents(previous, match));
        await this.repository.saveEvents(snapshot.events.filter(e => e.matchId === match.id));
        await this.repository.saveMatch(match);
      }
    } finally { this.running = false; }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
