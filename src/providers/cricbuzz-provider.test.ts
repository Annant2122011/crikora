import { describe, expect, it } from "vitest";
import { classifyCricbuzzEntityUrl, classifyMatchFormat, labeledValue, parseCricbuzzEntityHtml } from "./cricbuzz-provider.js";

describe("Crikora cricket scope and format classification", () => {
  it("keeps The Hundred, T10 and Sixes distinct from T20", () => {
    expect(classifyMatchFormat("The Hundred - Manchester Originals vs Trent Rockets")).toBe("The Hundred");
    expect(classifyMatchFormat("Abu Dhabi T10 - Team A vs Team B")).toBe("T10");
    expect(classifyMatchFormat("Hong Kong Sixes - India vs Pakistan")).toBe("Sixes");
    expect(classifyMatchFormat("ICC Men's T20 World Cup")).toBe("T20");
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

  it("extracts flattened label/value pairs without truncating at whitespace", () => {
    const text = "Born 22 May 1987 Birth Place Durban Role All-rounder Batting Style Right hand bat Teams South Africa, Titans";
    expect(labeledValue(text, "Born")).toBe("22 May 1987");
    expect(labeledValue(text, "Birth Place")).toBe("Durban");
    expect(labeledValue(text, "Teams")).toBe("South Africa, Titans");
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

  it("includes women-only ranking URLs in Crikora cricket data", () => {
    expect(classifyCricbuzzEntityUrl("https://www.cricbuzz.com/cricket-stats/icc-rankings/women/batting")).toBeDefined();
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
