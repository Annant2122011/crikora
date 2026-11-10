import { describe, expect, it, vi } from "vitest";
import { CricbuzzProvider,
  isAllowedCricbuzzPageUrl,
  isAllowedCricbuzzSitemapUrl,
  parseCricbuzzSitemapXml
} from "./cricbuzz-provider.js";

describe("Cricbuzz sitemap discovery", () => {
  it.each([403, 404])("returns an empty live inventory when the root sitemap returns HTTP %i", async status => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Access denied", {
      status,
      headers: { "content-type": "text/html" }
    })));
    const provider = new CricbuzzProvider({
      minRequestIntervalMs: 0,
      maxMatchesPerPoll: 2,
      maxProfilesPerPoll: 1,
      maxTeamsPerPoll: 1,
      maxSeriesPerPoll: 1,
      maxVenuesPerPoll: 1,
      maxContentPagesPerPoll: 1,
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      userAgent: "Crikora test suite"
    });

    try {
      const result = await provider.discoverSitemapUrls();
      expect(result.sitemapUrls).toEqual([]);
      expect(result.pageUrls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      expect(globalThis.fetch).toBe(originalFetch);
    }
  });

  it("continues to surface a source 429 so the caller can honor Retry-After", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Rate limited", {
      status: 429,
      headers: { "content-type": "text/plain", "retry-after": "25" }
    })));
    const provider = new CricbuzzProvider({
      minRequestIntervalMs: 0,
      maxMatchesPerPoll: 2,
      maxProfilesPerPoll: 1,
      maxTeamsPerPoll: 1,
      maxSeriesPerPoll: 1,
      maxVenuesPerPoll: 1,
      maxContentPagesPerPoll: 1,
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      userAgent: "Crikora test suite"
    });

    try {
      await expect(provider.discoverSitemapUrls()).rejects.toMatchObject({
        sourceStatus: 429,
        retryAfterMs: 25_000
      });
    } finally {
      vi.unstubAllGlobals();
      expect(globalThis.fetch).toBe(originalFetch);
    }
  });

  it("separates child sitemap documents from allowed cricket pages", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://www.cricbuzz.com/sitemap/cricket-news.xml</loc></url>
        <url><loc>https://www.cricbuzz.com/profiles/10012/smriti-mandhana</loc></url>
        <url><loc>https://www.cricbuzz.com/cricket-match-facts/177291/womens-victoria-t20i</loc></url>
        <url><loc>https://www.cricbuzz.com/cricket-series/9241/indian-premier-league-2026/matches</loc></url>
        <url><loc>https://www.cricbuzz.com/premium-subscription/user/account-info</loc></url>
        <url><loc>https://www.cricbuzz.com/info/advertise</loc></url>
        <url><loc>https://evil.example/profiles/1/not-cricbuzz</loc></url>
      </urlset>`;
    const result = parseCricbuzzSitemapXml(xml);

    expect(result.sitemapUrls).toEqual([
      "https://www.cricbuzz.com/sitemap/cricket-news.xml"
    ]);
    expect(result.pageUrls).toEqual([
      "https://www.cricbuzz.com/profiles/10012/smriti-mandhana",
      "https://www.cricbuzz.com/cricket-match-facts/177291/womens-victoria-t20i",
      "https://www.cricbuzz.com/cricket-series/9241/indian-premier-league-2026/matches"
    ]);
    expect(isAllowedCricbuzzPageUrl(
      "https://www.cricbuzz.com/cricket-match-facts/177291/womens-victoria-t20i"
    )).toBe(true);
  });

  it("decodes XML entities before validating and normalizing page URLs", () => {
    const result = parseCricbuzzSitemapXml(
      "<urlset><url><loc>https://www.cricbuzz.com/live-cricket-scores/161256/nz-vs-ind?view=full&amp;lang=en</loc></url></urlset>"
    );

    expect(result.pageUrls).toEqual([
      "https://www.cricbuzz.com/live-cricket-scores/161256/nz-vs-ind?view=full&lang=en"
    ]);
  });


  it("accepts cricket routes but excludes unrelated sitemap-listed site pages", () => {
    const cricketUrls = [
      "https://www.cricbuzz.com/live-cricket-scores/161256/nz-vs-ind",
      "https://www.cricbuzz.com/cricket-series/9241/indian-premier-league-2026",
      "https://www.cricbuzz.com/cricket-news/140765/sample-story"
    ];
    for (const url of cricketUrls) expect(isAllowedCricbuzzPageUrl(url)).toBe(true);

    const unrelatedUrls = [
      "https://www.cricbuzz.com/",
      "https://www.cricbuzz.com/info/contact",
      "https://www.cricbuzz.com/info/advertise",
      "https://www.cricbuzz.com/careers",
      "https://www.cricbuzz.com/premium-subscription/user/account-info",
      "https://www.cricbuzz.com/api/private",
      "https://evil.example/cricket-news/140001/story"
    ];
    for (const url of unrelatedUrls) expect(isAllowedCricbuzzPageUrl(url)).toBe(false);
  });

  it("does not crash on an invalid numeric XML character reference", () => {
    const result = parseCricbuzzSitemapXml(
      "<urlset><url><loc>https://www.cricbuzz.com/cricket-news/140765/example?x=&#x110000;</loc></url></urlset>"
    );
    expect(result.pageUrls).toEqual([
      "https://www.cricbuzz.com/cricket-news/140765/example?x="
    ]);
  });

  it("recognizes nested sitemap references without treating them as page records", () => {
    const result = parseCricbuzzSitemapXml(
      "<sitemapindex><sitemap><loc>https://www.cricbuzz.com/sitemap/cricket-news-archive.xml</loc></sitemap></sitemapindex>"
    );
    expect(result.sitemapUrls).toEqual([
      "https://www.cricbuzz.com/sitemap/cricket-news-archive.xml"
    ]);
    expect(result.pageUrls).toEqual([]);
  });

  it("accepts only HTTPS sitemap files on the exact Cricbuzz host", () => {
    expect(isAllowedCricbuzzSitemapUrl("https://www.cricbuzz.com/sitemap.xml")).toBe(true);
    expect(isAllowedCricbuzzSitemapUrl("https://www.cricbuzz.com/sitemap/cricket-videos.xml")).toBe(true);
    expect(isAllowedCricbuzzSitemapUrl("http://www.cricbuzz.com/sitemap.xml")).toBe(false);
    expect(isAllowedCricbuzzSitemapUrl("https://cricbuzz.com/sitemap.xml")).toBe(false);
    expect(isAllowedCricbuzzSitemapUrl("https://evil.example/sitemap.xml")).toBe(false);
    expect(isAllowedCricbuzzSitemapUrl("https://www.cricbuzz.com/sitemap/untrusted.html")).toBe(false);
  });
});
