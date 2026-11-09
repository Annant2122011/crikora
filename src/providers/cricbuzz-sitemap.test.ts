import { describe, expect, it } from "vitest";
import {
  isAllowedCricbuzzSitemapUrl,
  parseCricbuzzSitemapXml
} from "./cricbuzz-provider.js";

describe("Cricbuzz sitemap discovery", () => {
  it("separates child sitemap documents from allowed cricket pages", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://www.cricbuzz.com/sitemap/cricket-news.xml</loc></url>
        <url><loc>https://www.cricbuzz.com/profiles/10012/smriti-mandhana</loc></url>
        <url><loc>https://www.cricbuzz.com/cricket-match-facts/177291/womens-victoria-t20i</loc></url>
        <url><loc>https://www.cricbuzz.com/cricket-series/9241/indian-premier-league-2026/matches</loc></url>
        <url><loc>https://www.cricbuzz.com/premium-subscription/user/account-info</loc></url>
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
  });

  it("decodes XML entities before validating and normalizing page URLs", () => {
    const result = parseCricbuzzSitemapXml(
      "<urlset><url><loc>https://www.cricbuzz.com/live-cricket-scores/161256/nz-vs-ind?view=full&amp;lang=en</loc></url></urlset>"
    );

    expect(result.pageUrls).toEqual([
      "https://www.cricbuzz.com/live-cricket-scores/161256/nz-vs-ind?view=full&lang=en"
    ]);
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
