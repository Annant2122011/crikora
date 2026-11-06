import { describe, expect, it } from "vitest";
import { classifyCricbuzzEntityUrl, parseCricbuzzEntityHtml } from "./cricbuzz-provider.js";

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
