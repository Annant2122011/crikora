import { describe, expect, it } from "vitest";
import { hashEntityPayload } from "./postgres-entity-repository.js";

describe("permanent archive entity hashing", () => {
  it("does not create a new version for polling timestamps alone", () => {
    const first = hashEntityPayload({
      player: "Example Player",
      score: 100,
      fetchedAt: "2026-11-10T10:00:00.000Z",
      updatedAt: "2026-11-10T10:00:00.000Z"
    });
    const refreshed = hashEntityPayload({
      updatedAt: "2026-11-10T10:00:10.000Z",
      score: 100,
      fetchedAt: "2026-11-10T10:00:10.000Z",
      player: "Example Player"
    });
    expect(refreshed).toBe(first);
  });

  it("ignores collector-generated delivery observation timestamps", () => {
    const first = hashEntityPayload({
      sourceId: "match-1",
      runs: 100,
      events: [{ type: "four", summary: "FOUR", occurredAt: "2026-11-10T10:00:00.000Z" }]
    });
    const refreshed = hashEntityPayload({
      sourceId: "match-1",
      runs: 100,
      events: [{ type: "four", summary: "FOUR", occurredAt: "2026-11-10T10:00:10.000Z" }]
    });
    expect(refreshed).toBe(first);
  });

  it("creates a new content hash when an actual cricket field changes", () => {
    const previous = hashEntityPayload({ sourceId: "match-1", runs: 100, wickets: 2 });
    const next = hashEntityPayload({ sourceId: "match-1", runs: 101, wickets: 2 });
    expect(next).not.toBe(previous);
  });
});
