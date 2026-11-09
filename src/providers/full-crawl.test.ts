import { describe, expect, it } from "vitest";
import { classifyCricbuzzEntityUrl, dedupeCricbuzzPageUrls, isAllowedCricbuzzPageUrl } from "./cricbuzz-provider.js";

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

  it("rejects external hosts, non-HTTPS URLs and unlisted internal routes", () => {
    expect(isAllowedCricbuzzPageUrl("https://example.com/profiles/1/example")).toBe(false);
    expect(isAllowedCricbuzzPageUrl("http://www.cricbuzz.com/profiles/1/example")).toBe(false);
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/api/private")).toBe(false);
  });


  it("deduplicates slug aliases by stable entity identity without collapsing page types", () => {
    const urls = [
      "https://www.cricbuzz.com/live-cricket-scores/161256/old-match-slug",
      "https://www.cricbuzz.com/live-cricket-scores/161256/current-match-slug",
      "https://www.cricbuzz.com/cricket-match-facts/161256/old-match-slug",
      "https://www.cricbuzz.com/cricket-match-facts/161256/current-match-slug",
      "https://www.cricbuzz.com/cricket-match-squads/161256/current-match-slug",
      "https://www.cricbuzz.com/live-cricket-scorecard/161256/current-match-slug",
      "https://www.cricbuzz.com/profiles/326/old-player/all-matches/batting",
      "https://www.cricbuzz.com/profiles/326/current-player/all-matches/batting",
      "https://www.cricbuzz.com/cricket-series/2727/old-series/stats",
      "https://www.cricbuzz.com/cricket-series/2727/current-series/stats",
      "https://www.cricbuzz.com/cricket-series/2727/current-series/squads",
      "https://www.cricbuzz.com/cricket-team/india/2/squad",
      "https://www.cricbuzz.com/cricket-team/bharat/2/squad"
    ];

    expect(dedupeCricbuzzPageUrls(urls)).toEqual([
      urls[0],
      urls[2],
      urls[4],
      urls[5],
      urls[6],
      urls[8],
      urls[10],
      urls[11]
    ]);
  });

  it("normalizes trailing slashes while retaining separate match page identities", () => {
    const urls = [
      "https://www.cricbuzz.com/live-cricket-scores/161256/example/",
      "https://www.cricbuzz.com/live-cricket-scores/161256/another-example",
      "https://www.cricbuzz.com/cricket-match-facts/161256/example",
      "https://www.cricbuzz.com/live-cricket-scorecard/161256/example",
      "https://www.cricbuzz.com/cricket-match-squads/161256/example"
    ];
    const result = dedupeCricbuzzPageUrls(urls);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe("https://www.cricbuzz.com/live-cricket-scores/161256/example");
    expect(result.map(url => classifyCricbuzzEntityUrl(url)?.sourceId)).toEqual([
      "161256",
      "match-facts:161256",
      "match-scorecard:161256",
      "match-squads:161256"
    ]);
  });

  it("accepts the additional public pages explicitly listed in Cricbuzz's sitemap index", () => {
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/")).toBe(true);
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/info/contact")).toBe(true);
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/careers")).toBe(true);
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/premium-subscription/user/account-info")).toBe(true);
  });
});
