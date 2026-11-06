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

  it("rejects URLs that are not known entity routes", () => {
    expect(classifyCricbuzzEntityUrl("https://example.com/profiles/11527/paul-walter")).toBeUndefined();
    expect(classifyCricbuzzEntityUrl("not a URL")).toBeUndefined();
  });
});

describe("Cricbuzz HTML entity extraction", () => {
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
      expect.objectContaining({ url: "https://static.cricbuzz.com/images/player-100.jpg", alt: "Sample Player" })
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
