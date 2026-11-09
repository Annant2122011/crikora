export const REFRESH_INTERVAL_OPTIONS = [10, 15, 20, 30] as const;
export type RefreshIntervalSeconds = typeof REFRESH_INTERVAL_OPTIONS[number];
export const DEFAULT_REFRESH_INTERVAL_SECONDS: RefreshIntervalSeconds = 10;

export function parseRefreshIntervalSeconds(value: unknown): RefreshIntervalSeconds | undefined {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return REFRESH_INTERVAL_OPTIONS.includes(parsed as RefreshIntervalSeconds)
    ? parsed as RefreshIntervalSeconds
    : undefined;
}
