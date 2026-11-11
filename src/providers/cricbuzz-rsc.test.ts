import { describe, expect, it } from "vitest";
import { decodeCricbuzzFlightScripts } from "./cricbuzz-rsc.js";

describe("Cricbuzz React Server Component decoder", () => {
  it("decodes JSON rows and UTF-8 byte-length text rows", () => {
    const flight = [
      '1:{"playerData":{"name":"Example Batter","role":"Batter"}}',
      "2:T3,é!",
      ""
    ].join("\n");
    const script = `self.__next_f.push([1,${JSON.stringify(flight)}]);`;

    const decoded = decodeCricbuzzFlightScripts([script]);

    expect(decoded?.rowCount).toBe(2);
    expect(decoded?.rows["1"]).toEqual({
      playerData: { name: "Example Batter", role: "Batter" }
    });
    expect(decoded?.rows["2"]).toBe("é!");
    expect(decoded?.keyedData.playerData?.[0]).toEqual({
      name: "Example Batter",
      role: "Batter"
    });
  });

  it("resolves row references inside nested player data", () => {
    const flight = [
      '1:{"playerData":{"name":"Example Batter","bio":"$2","career":"$3","unused":"$undefined"}}',
      "2:T26,This player has a long-form biography.",
      '3:{"odi":{"matches":12,"runs":700},"test":{"matches":3,"runs":90}}',
      ""
    ].join("\n");
    const script = `self.__next_f.push([1,${JSON.stringify(flight)}]);`;

    const decoded = decodeCricbuzzFlightScripts([script]);

    expect(decoded?.keyedData.playerData?.[0]).toEqual({
      name: "Example Batter",
      bio: "This player has a long-form biography.",
      career: { odi: { matches: 12, runs: 700 }, test: { matches: 3, runs: 90 } },
      unused: null
    });
  });

  it("combines multiple React flight chunks", () => {
    const first = '1:{"matchInfo":{"id":123}}\n';
    const second = '2:{"matchHeader":{"state":"Complete"}}\n';
    const scripts = [
      `self.__next_f.push([1,${JSON.stringify(first)}]);`,
      `self.__next_f.push([1,${JSON.stringify(second)}]);`
    ];

    const decoded = decodeCricbuzzFlightScripts(scripts);

    expect(decoded?.rowCount).toBe(2);
    expect(decoded?.keyedData.matchInfo?.[0]).toEqual({ id: 123 });
    expect(decoded?.keyedData.matchHeader?.[0]).toEqual({ state: "Complete" });
  });

  it("returns undefined when a page has no usable flight script", () => {
    expect(decodeCricbuzzFlightScripts([])).toBeUndefined();
    expect(decodeCricbuzzFlightScripts(["window.__NEXT_DATA__ = {};"])).toBeUndefined();
  });
});
