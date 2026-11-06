import {
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  parseRefreshIntervalSeconds,
  type RefreshIntervalSeconds
} from "../ingestion/refresh-interval.js";

export type RefreshCallback = () => Promise<unknown> | unknown;
export type RefreshErrorCallback = (error: unknown) => void;

/**
 * Client-side cadence controller.
 *
 * Vercel Functions are request-driven, so an active extension/backend calls
 * this controller to request a refresh. The source credential stays on the
 * server; this callback should call the Crikora backend, not Cricbuzz.
 */
export class CrikoraRefreshController {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  private intervalSeconds: RefreshIntervalSeconds;

  constructor(
    private readonly refresh: RefreshCallback,
    intervalSeconds: number = DEFAULT_REFRESH_INTERVAL_SECONDS,
    private readonly onError: RefreshErrorCallback = () => undefined
  ) {
    const parsed = parseRefreshIntervalSeconds(intervalSeconds);
    if (!parsed) {
      throw new RangeError("Refresh interval must be 10, 15, 20 or 30 seconds.");
    }
    this.intervalSeconds = parsed;
  }

  get refreshIntervalSeconds(): RefreshIntervalSeconds {
    return this.intervalSeconds;
  }

  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  start(options: { immediate?: boolean } = {}): void {
    if (this.timer) return;
    if (options.immediate !== false) void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalSeconds * 1000);
  }

  setRefreshIntervalSeconds(value: number): void {
    const parsed = parseRefreshIntervalSeconds(value);
    if (!parsed) {
      throw new RangeError("Refresh interval must be 10, 15, 20 or 30 seconds.");
    }
    const wasRunning = this.isRunning;
    this.stop();
    this.intervalSeconds = parsed;
    if (wasRunning) this.start({ immediate: false });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.refresh();
    } catch (error) {
      this.onError(error);
    } finally {
      this.inFlight = false;
    }
  }
}
