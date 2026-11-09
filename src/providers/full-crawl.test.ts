import { describe, expect, it } from "vitest";
import { classifyCricbuzzEntityUrl, isAllowedCricbuzzPageUrl } from "./cricbuzz-provider.js";

describe("full-crawl route coverage", () => {
  it("allows facts, scorecard and squad pages used by match enrichment", () => {
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/cricket-match-facts/161256/example")).toBe(true);
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/cricket-match-squads/161256/example")).toBe(true);
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/live-cricket-scorecard/161256/example")).toBe(true);
  });

  it("classifies match overviews separately from related match pages", () => {
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/live-cricket-scores/161256/example"))
      .toEqual({ entityType: "match", sourceId: "161256" });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-match-facts/161256/example"))
      .toEqual({ entityType: "metadata", sourceId: "match-facts:161256" });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-match-squads/161256/example"))
      .toEqual({ entityType: "metadata", sourceId: "match-squads:161256" });
  });

  it("rejects external hosts, non-HTTPS URLs and non-content routes", () => {
    expect(isAllowedCricbuzzPageUrl("https://example.com/profiles/1/example")).toBe(false);
    expect(isAllowedCricbuzzPageUrl("http://www.cricbuzz.com/profiles/1/example")).toBe(false);
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/premium-subscription/user/account-info")).toBe(false);
  });
});
