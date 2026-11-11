import { describe, expect, it, vi } from "vitest";
import {
  CricbuzzProvider, classifyCricbuzzEntityUrl, classifyMatchFormat, getCricbuzzDiscoverySeedUrls,
  isAllowedCricbuzzPageUrl, isTargetedCricbuzzCollectionUrl, isTargetedCricbuzzSeedUrl, isUsablePlayerImage,
  labeledValue, parseCricbuzzEntityHtml, shouldFollowTargetedPageLink
} from "./cricbuzz-provider.js";

describe("player headshot validation", () => {
  it("rejects Cricbuzz's site-wide Open Graph image as a player photo", () => {
    expect(isUsablePlayerImage("https://static.cricbuzz.com/a/img/v1/i1/c582022/i.jpg?d=high&p=det")).toBe(false);
  });

  it("keeps valid individual HTTPS player headshots", () => {
    expect(isUsablePlayerImage("https://static.cricbuzz.com/a/img/v1/i1/c123456/real-player.jpg")).toBe(true);
    expect(isUsablePlayerImage("http://static.cricbuzz.com/a/img/v1/i1/c123456/real-player.jpg")).toBe(false);
    expect(isUsablePlayerImage(undefined)).toBe(false);
  });
});

describe("Crikora cricket scope and format classification", () => {
  it("keeps The Hundred, T10 and Sixes distinct from T20", () => {
    expect(classifyMatchFormat("The Hundred - Manchester Originals vs Trent Rockets")).toBe("The Hundred");
    expect(classifyMatchFormat("Abu Dhabi T10 - Team A vs Team B")).toBe("T10");
    expect(classifyMatchFormat("Hong Kong Sixes - India vs Pakistan")).toBe("Sixes");
    expect(classifyMatchFormat("ICC Men's T20 World Cup")).toBe("T20");
  });

});
describe("expanded public cricket sitemap scope", () => {
  it("includes team, series, player performance and men's/women's ranking pages", () => {
    for (const url of [
      "https://www.cricbuzz.com/cricket-team/india/2",
      "https://www.cricbuzz.com/cricket-team/sierra-leone-women/490/results",
      "https://www.cricbuzz.com/cricket-series/12677/womens-big-bash-league-2026/points-table",
      "https://www.cricbuzz.com/cricket-series/9241/indian-premier-league-2026/stats",
      "https://www.cricbuzz.com/player-match-performance/match/22397/player/1836/batting",
      "https://www.cricbuzz.com/cricket-stats/icc-rankings/women/batting",
      "https://www.cricbuzz.com/cricket-stats/icc-rankings/men/batting"
    ]) {
      expect(isTargetedCricbuzzCollectionUrl(url), url).toBe(true);
    }
  });

  it("keeps video, photo-gallery, premium and contact pages outside the cricket-data crawl", () => {
    for (const url of [
      "https://www.cricbuzz.com/cricket-videos",
      "https://www.cricbuzz.com/cricket-gallery/6067/world-cup-celebrations",
      "https://www.cricbuzz.com/premium-subscription/user/account-info",
      "https://www.cricbuzz.com/info/contact"
    ]) {
      expect(isTargetedCricbuzzCollectionUrl(url), url).toBe(false);
    }
  });
});

describe("Cricbuzz player detail extraction", () => {
  it("extracts all labelled profile fields, not only a fixed handful", () => {
    const entity = parseCricbuzzEntityHtml(
      `<html><main><h1>Example Player</h1><table>
        <tr><th>Born</th><td>22 May 1987</td></tr>
        <tr><th>Role</th><td>All-rounder</td></tr>
        <tr><th>Batting Style</th><td>Right hand bat</td></tr>
        <tr><th>Test Debut</th><td>1 January 2008</td></tr>
        <tr><th>IPL Debut</th><td>2009</td></tr>
      </table><h2>Summary</h2><p>Example career summary.</p></main></html>`,
      "https://www.cricbuzz.com/profiles/999999/example-player"
    );
    const profile = entity?.payload.profile as Record<string, unknown>;
    const allFields = profile.allFields as Record<string, string>;
    expect(allFields).toMatchObject({
      Born: "22 May 1987",
      Role: "All-rounder",
      "Batting Style": "Right hand bat",
      "Test Debut": "1 January 2008",
      "IPL Debut": "2009"
    });
    expect(profile.biographySections).toEqual(
      expect.arrayContaining([expect.objectContaining({ heading: "Summary", text: "Example career summary." })])
    );
  });

  it("links player statistics tabs back to the parent player identity", () => {
    const entity = parseCricbuzzEntityHtml(
      "<html><main><h1>Example Player Batting</h1><table><thead><tr><th>Matches</th></tr></thead><tbody><tr><td>20</td></tr></tbody></table></main></html>",
      "https://www.cricbuzz.com/profiles/999999/example-player/all-matches/batting"
    );
    expect(entity?.entityType).toBe("metadata");
    expect(entity?.payload).toMatchObject({
      pageKind: "player-stats",
      relatedEntityType: "player",
      relatedSourceId: "999999",
      statistics: [{ headers: ["Matches"], rows: [["20"]] }]
    });
  });

  it("extracts flattened label/value pairs without truncating at whitespace", () => {
    const text = "Born 22 May 1987 Birth Place Durban Role All-rounder Batting Style Right hand bat Teams South Africa, Titans";
    expect(labeledValue(text, "Born")).toBe("22 May 1987");
    expect(labeledValue(text, "Birth Place")).toBe("Durban");
    expect(labeledValue(text, "Teams")).toBe("South Africa, Titans");
  });
});

describe("Crikora initial collection seed scope", () => {
  it("seeds matches, full player profiles, news, schedules and relevant series context", () => {
    const included = [
      "https://www.cricbuzz.com/live-cricket-scores/176154/yl-vs-ut-9th-match-t10-2026",
      "https://www.cricbuzz.com/profiles/10012/smriti-mandhana",
      "https://www.cricbuzz.com/profiles/10012/smriti-mandhana/batting",
      "https://www.cricbuzz.com/cricket-news/140543/example-story",
      "https://www.cricbuzz.com/cricket-schedule/upcoming-series/all",
      "https://www.cricbuzz.com/cricket-series/12677/womens-big-bash-league-2026",
      "https://www.cricbuzz.com/cricket-series/12677/womens-big-bash-league-2026/matches",
      "https://www.cricbuzz.com/cricket-series/12677/womens-big-bash-league-2026/points-table",
      "https://www.cricbuzz.com/cricket-stats/icc-rankings/women/batting"
    ];
    for (const url of included) expect(isTargetedCricbuzzSeedUrl(url), url).toBe(true);
  });

  it("does not seed match companions, historical player-match pages, team directories or auction/video routes", () => {
    const excluded = [
      "https://www.cricbuzz.com/live-cricket-scorecard/170703/pak-vs-sl-1st-test",
      "https://www.cricbuzz.com/cricket-match-facts/170703/pak-vs-sl-1st-test",
      "https://www.cricbuzz.com/cricket-match-squads/170703/pak-vs-sl-1st-test",
      "https://www.cricbuzz.com/live-cricket-full-commentary/170703/pak-vs-sl-1st-test",
      "https://www.cricbuzz.com/player-match-performance/match/22397/player/1836/batting",
      "https://www.cricbuzz.com/cricket-team/india/2",
      "https://www.cricbuzz.com/cricket-team/sierra-leone-women/490/results",
      "https://www.cricbuzz.com/cricket-series/ipl-2026/auction/players",
      "https://www.cricbuzz.com/cricket-series/12677/womens-big-bash-league-2026/videos"
    ];
    for (const url of excluded) expect(isTargetedCricbuzzSeedUrl(url), url).toBe(false);
  });
});

describe("Cricbuzz targeted discovery seeds", () => {
  it("seeds match indexes and focused schedule/news indexes, not unrelated directories or historical archive routes", () => {
    const seeds = getCricbuzzDiscoverySeedUrls();
    expect(seeds).toEqual(expect.arrayContaining([
      "https://www.cricbuzz.com/cricket-match/live-scores",
      "https://www.cricbuzz.com/cricket-match/live-scores/upcoming-matches",
      "https://www.cricbuzz.com/cricket-match/live-scores/recent-matches",
      "https://www.cricbuzz.com/cricket-schedule/upcoming-series/all",
      "https://www.cricbuzz.com/cricket-schedule/upcoming-series/international",
      "https://www.cricbuzz.com/cricket-news/latest-news"
    ]));
    expect(seeds.some(value => /profiles|cricket-team|scorecard-archives|cricket-videos|cricket-stats/.test(value))).toBe(false);
    expect(seeds.every(isTargetedCricbuzzCollectionUrl)).toBe(true);
  });

  it("accepts both men's and women's data, while rejecting unused page families", () => {
    const allowed = [
      "https://www.cricbuzz.com/live-cricket-scores/555/example-women-vs-women",
      "https://www.cricbuzz.com/cricket-series/555/womens-league",
      "https://www.cricbuzz.com/profiles/777/women-player",
      "https://www.cricbuzz.com/profiles/777/women-player/batting",
      "https://www.cricbuzz.com/cricket-news/140765/example-story",
      "https://www.cricbuzz.com/cricket-schedule/series/all"
    ];
    for (const value of allowed) expect(isTargetedCricbuzzCollectionUrl(value)).toBe(true);
    expect(isTargetedCricbuzzCollectionUrl("https://www.cricbuzz.com/cricket-scorecard-archives/1877")).toBe(false);
    expect(isTargetedCricbuzzCollectionUrl("https://www.cricbuzz.com/cricket-videos/217038/example")).toBe(false);
    expect(isTargetedCricbuzzCollectionUrl("https://www.cricbuzz.com/cricket-stats/icc-rankings/women/batting")).toBe(true);
    expect(isTargetedCricbuzzCollectionUrl("https://www.cricbuzz.com/cricket-stats/icc-rankings/men/batting")).toBe(true);
  });
});

describe("targeted link following", () => {
  const matchIndex = "https://www.cricbuzz.com/cricket-match/live-scores";
  const matchPage = "https://www.cricbuzz.com/live-cricket-scores/176500/teams-match";
  const squadsPage = "https://www.cricbuzz.com/cricket-match-squads/176500/teams-match";
  const factsPage = "https://www.cricbuzz.com/cricket-match-facts/176500/teams-match";
  const scorecardPage = "https://www.cricbuzz.com/live-cricket-scorecard/176500/teams-match";
  const commentaryPage = "https://www.cricbuzz.com/live-cricket-full-commentary/176500/teams-match";
  const player = "https://www.cricbuzz.com/profiles/777/sample-player";
  const batting = "https://www.cricbuzz.com/profiles/777/sample-player/all-matches/batting";
  const otherPlayer = "https://www.cricbuzz.com/profiles/778/another-player";
  const newsIndex = "https://www.cricbuzz.com/cricket-news";
  const newsA = "https://www.cricbuzz.com/cricket-news/140765/story-a";
  const newsB = "https://www.cricbuzz.com/cricket-news/140766/story-b";
  const schedule = "https://www.cricbuzz.com/cricket-schedule/series/all";

  it("follows match indexes, match participants, player statistics, schedules and news indexes without page-family fanout", () => {
    expect(shouldFollowTargetedPageLink(matchIndex, matchPage)).toBe(true);
    expect(shouldFollowTargetedPageLink(matchIndex, squadsPage)).toBe(false);
    expect(shouldFollowTargetedPageLink(matchIndex, factsPage)).toBe(false);
    expect(shouldFollowTargetedPageLink(matchIndex, scorecardPage)).toBe(false);
    expect(shouldFollowTargetedPageLink(matchIndex, commentaryPage)).toBe(false);
    expect(shouldFollowTargetedPageLink(schedule, squadsPage)).toBe(false);
    expect(shouldFollowTargetedPageLink(schedule, factsPage)).toBe(false);
    expect(shouldFollowTargetedPageLink(schedule, scorecardPage)).toBe(false);
    expect(shouldFollowTargetedPageLink(schedule, commentaryPage)).toBe(false);
    expect(shouldFollowTargetedPageLink(matchPage, squadsPage)).toBe(false);
    expect(shouldFollowTargetedPageLink(squadsPage, player)).toBe(true);
    expect(shouldFollowTargetedPageLink(player, batting)).toBe(true);
    expect(shouldFollowTargetedPageLink(player, otherPlayer)).toBe(false);
    expect(shouldFollowTargetedPageLink(newsIndex, newsA)).toBe(true);
    expect(shouldFollowTargetedPageLink(newsA, newsB)).toBe(false);
    expect(shouldFollowTargetedPageLink(schedule, matchPage)).toBe(true);
  });
});

describe("Cricbuzz source URL classification", () => {
  it("identifies player profiles by their stable numeric ID", () => {
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/profiles/11527/paul-walter"))
      .toEqual({ entityType: "player", sourceId: "11527" });
  });

  it("identifies venue pages before their parent series route", () => {
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-series/11493/the-hundred/venues/18/trent-bridge"))
      .toEqual({ entityType: "venue", sourceId: "18" });
  });

  it("classifies the added public content page families", () => {
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-news/140765/example-story"))
      .toEqual({ entityType: "metadata", sourceId: "news:140765" });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-videos/217038/example-highlight"))
      .toEqual({ entityType: "metadata", sourceId: "video:217038" });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-gallery/6070/example-gallery"))
      .toEqual({ entityType: "metadata", sourceId: "gallery:6070" });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-stats/icc-rankings/men/batting"))
      .toMatchObject({ entityType: "metadata", sourceId: expect.stringContaining("ranking-or-statistics:") });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-schedule/series/all"))
      .toMatchObject({ entityType: "metadata", sourceId: expect.stringContaining("schedule:") });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-match-forecast/161234/example-series"))
      .toEqual({ entityType: "metadata", sourceId: "match-forecast:161234" });
  });

  it("classifies video collection, playlist and category pages", () => {
    const collection = classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-videos/collection/1/latest-videos");
    expect(collection?.entityType).toBe("metadata");
    expect(collection?.sourceId).toMatch(/^video-collection:1:/);
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-videos/playlists"))
      .toEqual({ entityType: "metadata", sourceId: expect.stringContaining("video-playlists:") });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-videos/categories"))
      .toEqual({ entityType: "metadata", sourceId: expect.stringContaining("video-categories:") });
  });

  it("classifies match highlights, live graphs and Wicket Zone pages", () => {
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-match-highlights/161256/nz-vs-ind"))
      .toEqual({ entityType: "metadata", sourceId: "match-highlights:161256" });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/live-cricket-graphs/161256/nz-vs-ind"))
      .toEqual({ entityType: "metadata", sourceId: "live-graphs:161256" });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/special-content/wicket-zone/11209/icc-under-19-world-cup-2026"))
      .toEqual({ entityType: "metadata", sourceId: "wicket-zone:11209" });
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-series/ipl-2013/auction/players/8284"))
      .toMatchObject({ entityType: "metadata", sourceId: expect.stringContaining("series-auction:ipl-2013:") });
  });

  it("classifies stream landing pages and player match performance subpages", () => {
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/live-cricket-stream/175617/paku19-vs-uaeu19"))
      .toEqual({ entityType: "metadata", sourceId: "live-stream-page:175617" });
    const batting = classifyCricbuzzEntityUrl("https://www.cricbuzz.com/player-match-performance/match/22509/player/9647/batting");
    const bowling = classifyCricbuzzEntityUrl("https://www.cricbuzz.com/player-match-performance/match/22509/player/9647/bowling");
    expect(batting?.entityType).toBe("metadata");
    expect(batting?.sourceId).toContain("player-match-performance:22509:");
    expect(bowling?.sourceId).toContain("player-match-performance:22509:");
    expect(batting?.sourceId).not.toBe(bowling?.sourceId);
  });

  it("uses the numeric team ID in distinct team subpage keys", () => {
    const squad = classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-team/india/2/squad");
    const results = classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-team/india/2/results");
    expect(squad?.entityType).toBe("metadata");
    expect(squad?.sourceId).toMatch(/^team-subpage:2:/);
    expect(results?.sourceId).toMatch(/^team-subpage:2:/);
    expect(squad?.sourceId).not.toBe(results?.sourceId);
  });

  it("uses distinct stable IDs for different player and series subpages", () => {
    const playerBatting = classifyCricbuzzEntityUrl("https://www.cricbuzz.com/profiles/326/mohammad-asif/all-matches/batting");
    const playerBowling = classifyCricbuzzEntityUrl("https://www.cricbuzz.com/profiles/326/mohammad-asif/all-matches/bowling");
    const seriesStats = classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-series/2727/big-bash-league/stats");
    const seriesSquads = classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-series/2727/big-bash-league/squads");
    expect(playerBatting?.entityType).toBe("metadata");
    expect(playerBowling?.entityType).toBe("metadata");
    expect(playerBatting?.sourceId).not.toBe(playerBowling?.sourceId);
    expect(seriesStats?.sourceId).not.toBe(seriesSquads?.sourceId);
  });

  it("includes men's and women's match, series, player and ranking routes", () => {
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-stats/icc-rankings/women/batting"))
      .toMatchObject({ entityType: "metadata", sourceId: expect.stringContaining("ranking-or-statistics:") });
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/cricket-stats/icc-rankings/women/batting")).toBe(true);
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/live-cricket-scores/555/example-women-vs-women")).toBe(true);
    expect(isAllowedCricbuzzPageUrl("https://www.cricbuzz.com/cricket-series/555/womens-league")).toBe(true);
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/profiles/777/women-player"))
      .toEqual({ entityType: "player", sourceId: "777" });
  });

  it("classifies the 1877 historical archive year page", () => {
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-scorecard-archives/1877"))
      .toEqual({ entityType: "metadata", sourceId: "scorecard-archives:1877" });
  });
  it("rejects URLs that are not known entity routes", () => {
    expect(classifyCricbuzzEntityUrl("https://example.com/profiles/11527/paul-walter")).toBeUndefined();
    expect(classifyCricbuzzEntityUrl("not a URL")).toBeUndefined();
  });
});

describe("Cricbuzz HTML entity extraction", () => {
  it("returns article metadata and image references as URL strings", () => {
    const html = `
      <!doctype html><html><head>
        <title>Sample Cricket News</title>
        <meta property="og:title" content="Sample Cricket News">
        <meta property="og:image" content="https://static.cricbuzz.com/images/news.jpg">
        <meta property="og:video" content="https://video.cricbuzz.com/highlight.mp4">
      </head><body><main>
        <h1>Sample Cricket News</h1>
        <p>Match report body text.</p>
      </main></body></html>`;
    const entity = parseCricbuzzEntityHtml(
      html,
      "https://www.cricbuzz.com/cricket-news/140765/sample-story"
    );
    expect(entity?.entityType).toBe("metadata");
    expect(entity?.sourceId).toBe("news:140765");
    expect(entity?.payload.pageKind).toBe("news");
    expect(entity?.payload.images).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://static.cricbuzz.com/images/news.jpg" })
    ]));
    expect(entity?.payload.media).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://video.cricbuzz.com/highlight.mp4" })
    ]));
  });

  it("returns video poster and image_src references as absolute image URLs", () => {
    const entity = parseCricbuzzEntityHtml(
      `<html><head><link rel="image_src" href="//static.cricbuzz.com/poster.jpg"></head>
        <body><main><h1>Video</h1><video poster="/images/highlight-poster.jpg"></video></main></body></html>`,
      "https://www.cricbuzz.com/cricket-videos/217038/highlight"
    );
    expect(entity?.payload.images).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://static.cricbuzz.com/poster.jpg" }),
      expect.objectContaining({ url: "https://www.cricbuzz.com/images/highlight-poster.jpg" })
    ]));
  });

  it("returns JSON-ready profile, image, labels, tables and metadata", () => {
    const html = `
      <!doctype html><html><head>
        <title>Sample Player Profile</title>
        <meta property="og:title" content="Sample Player">
        <meta property="og:image" content="https://static.cricbuzz.com/images/player-100.jpg">
      </head><body>
        <main>
          <h1>Sample Player</h1>
          <img src="https://static.cricbuzz.com/images/player-100.jpg" alt="Sample Player">
          <div style="background-image: url('https://static.cricbuzz.com/images/player-bg.jpg')"></div>
          <button role="tab" data-tab="batting">Batting</button><button role="tab" data-tab="bowling">Bowling</button>\n          <h3>Personal Information</h3>
          <table><tr><th>Born</th><td>May 28, 1994</td></tr>
            <tr><th>Role</th><td>Batting Allrounder</td></tr></table>
          <h3>Career Summary</h3>
          <table><tr><th>Format</th><th>M</th><th>Runs</th></tr>
            <tr><td>ODI</td><td>20</td><td>500</td></tr></table>
          <a href="/cricket-team/england/1">England</a>
        </main>
      </body></html>`;
    const entity = parseCricbuzzEntityHtml(html, "https://www.cricbuzz.com/profiles/1234/sample-player");
    expect(entity?.entityType).toBe("player");
    expect(entity?.sourceId).toBe("1234");
    expect(entity?.payload.title).toBe("Sample Player");
    expect(entity?.payload.images).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://static.cricbuzz.com/images/player-100.jpg", alt: "Sample Player" }),
      expect.objectContaining({ url: "https://static.cricbuzz.com/images/player-bg.jpg" })
    ]));
    expect((entity?.payload.tables as Array<{ headers: string[] }>).length).toBe(2);
    expect(entity?.payload.meta).toMatchObject({ "og:title": "Sample Player" });
    expect(entity?.payload.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Batting", "data-tab": "batting" })
    ]));
    expect(entity?.payload.associations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/cricket-team/england/1" })
    ]));
  });
});

describe("targeted news sitemap discovery", () => {
  it("continues when an optional archive feed is absent but still respects other source failures", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith("cricket-news-archive.xml")) {
        return new Response("Not found", { status: 404 });
      }
      const slug = url.endsWith("cricket-news.xml") ? "current" : "editorial";
      const xml = `<urlset><url><loc>https://www.cricbuzz.com/cricket-news/${slug === "current" ? "140901/current-story" : "140902/editorial-story"}</loc></url></urlset>`;
      return new Response(xml, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = new CricbuzzProvider({
        minRequestIntervalMs: 0, maxMatchesPerPoll: 1, maxProfilesPerPoll: 1,
        maxTeamsPerPoll: 1, maxSeriesPerPoll: 1, maxVenuesPerPoll: 1,
        maxContentPagesPerPoll: 1, timeoutMs: 2_000, maxResponseBytes: 1_000_000,
        userAgent: "Crikora-Test/1.0"
      });
      const urls = await provider.discoverNewsSitemapUrls();
      expect(urls).toEqual(expect.arrayContaining([
        "https://www.cricbuzz.com/cricket-news/140901/current-story",
        "https://www.cricbuzz.com/cricket-news/140902/editorial-story"
      ]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("combines current, archived and editorial feeds without crawling other sitemap families", async () => {
    const feeds: Record<string, string[]> = {
      "https://www.cricbuzz.com/sitemap/cricket-news.xml": [
        "https://www.cricbuzz.com/cricket-news/140900/current-story"
      ],
      "https://www.cricbuzz.com/sitemap/cricket-news-archive.xml": [
        "https://www.cricbuzz.com/cricket-news/120000/archive-story"
      ],
      "https://www.cricbuzz.com/sitemap/cricket-news-editorials.xml": [
        "https://www.cricbuzz.com/cricket-news/130000/editorial-story"
      ]
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const key = input.toString();
      const urls = feeds[key] ?? [];
      const xml = `<?xml version="1.0"?><urlset>${urls.map(url => `<url><loc>${url}</loc></url>`).join("")}</urlset>`;
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const provider = new CricbuzzProvider({
        minRequestIntervalMs: 0,
        maxMatchesPerPoll: 1,
        maxProfilesPerPoll: 1,
        maxTeamsPerPoll: 1,
        maxSeriesPerPoll: 1,
        maxVenuesPerPoll: 1,
        maxContentPagesPerPoll: 1,
        timeoutMs: 2_000,
        maxResponseBytes: 1_000_000,
        userAgent: "Crikora-Test/1.0"
      });
      const urls = await provider.discoverNewsSitemapUrls();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.map(call => call[0].toString())).toEqual([
        "https://www.cricbuzz.com/sitemap/cricket-news.xml",
        "https://www.cricbuzz.com/sitemap/cricket-news-archive.xml",
        "https://www.cricbuzz.com/sitemap/cricket-news-editorials.xml"
      ]);
      expect(urls).toEqual(expect.arrayContaining(Object.values(feeds).flat()));
      expect(new Set(urls).size).toBe(3);
      expect(urls.some(url => /cricket-videos|cricket-photo-gallery/.test(url))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("targeted news and schedule normalization", () => {
  it("extracts complete news article metadata and body text", () => {
    const entity = parseCricbuzzEntityHtml(
      `<html><head>
        <meta property="og:title" content="A cricket report">
        <meta name="description" content="The short summary">
        <meta property="article:published_time" content="2026-11-05T09:00:00+05:30">
        <meta name="author" content="Cricbuzz Staff">
        <meta property="og:image" content="https://static.cricbuzz.com/news.jpg">
      </head><body><main><article><h1>A cricket report</h1>
        <div class="cb-nws-dtl-itms"><p>The first full article paragraph with meaningful detail.</p>
          <p>The second full article paragraph continues the report.</p></div>
      </article></main></body></html>`,
      "https://www.cricbuzz.com/cricket-news/140765/a-cricket-report"
    );
    expect(entity?.payload).toMatchObject({
      pageKind: "news",
      newsArticle: {
        sourceId: "news:140765",
        title: "A cricket report",
        summary: "The short summary",
        author: "Cricbuzz Staff",
        publishedAt: "2026-11-05T03:30:00.000Z",
        primaryImageUrl: "https://static.cricbuzz.com/news.jpg",
        bodyText: expect.stringContaining("The second full article paragraph")
      }
    });
  });

  it("extracts scheduled fixtures and links them to match source IDs", () => {
    const entity = parseCricbuzzEntityHtml(
      `<html><main><h1>Upcoming International Schedule</h1>
        <table><thead><tr><th>Date</th><th>Match</th><th>Venue</th></tr></thead><tbody>
          <tr><td>07 Nov 2026, 7:00 PM</td>
            <td><a href="/live-cricket-scores/176501/ind-vs-aus-1st-odi">India vs Australia, 1st ODI</a></td>
            <td>Wankhede Stadium</td></tr>
        </tbody></table>
      </main></html>`,
      "https://www.cricbuzz.com/cricket-schedule/series/all"
    );
    expect(entity?.payload).toMatchObject({
      pageKind: "schedule",
      scheduleFixtures: [expect.objectContaining({
        sourceId: "176501",
        matchUrl: "https://www.cricbuzz.com/live-cricket-scores/176501/ind-vs-aus-1st-odi",
        matchTitle: "India vs Australia, 1st ODI",
        homeTeam: "India",
        awayTeam: "Australia",
        format: "ODI",
        startTime: "2026-11-07T13:30:00.000Z",
        venue: "Wankhede Stadium"
      })]
    });
  });
});
