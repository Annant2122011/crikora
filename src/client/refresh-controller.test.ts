import { afterEach, describe, expect, it, vi } from "vitest";
import { CrikoraRefreshController } from "./refresh-controller.js";

describe("CrikoraRefreshController", () => {
  afterEach(() => vi.useRealTimers());

  it("defaults to ten seconds and starts immediately", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = new CrikoraRefreshController(refresh);

    controller.start();
    await Promise.resolve();

    expect(controller.refreshIntervalSeconds).toBe(10);
    expect(refresh).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it.each([10, 15, 20, 30])("supports a %i-second interval", seconds => {
    const controller = new CrikoraRefreshController(() => undefined);
    controller.setRefreshIntervalSeconds(seconds);
    expect(controller.refreshIntervalSeconds).toBe(seconds);
    controller.stop();
  });

  it("rejects unsupported intervals", () => {
    const controller = new CrikoraRefreshController(() => undefined);
    expect(() => controller.setRefreshIntervalSeconds(5)).toThrow(RangeError);
    expect(() => new CrikoraRefreshController(() => undefined, 60)).toThrow(RangeError);
  });

  it("does not start overlapping refresh callbacks", async () => {
    vi.useFakeTimers();
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(() => new Promise<void>(resolve => { resolveRefresh = resolve; }));
    const controller = new CrikoraRefreshController(refresh, 10);

    controller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    resolveRefresh?.();
    await Promise.resolve();
    controller.stop();
  });

  it("reports errors and continues on the next scheduled tick", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const controller = new CrikoraRefreshController(refresh, 10, onError);

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    controller.stop();
  });
});
