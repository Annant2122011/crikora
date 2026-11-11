import { afterEach, describe, expect, it, vi } from "vitest";
import { CricbuzzProvider } from "./cricbuzz-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("durable match extraction", () => {
  it("joins the overview with facts, scorecard, squads and commentary pages", async () => {
    const baseUrl = "https://www.cricbuzz.com/live-cricket-scores/161256/sample-match";
    const companionUrls = [
      "https://www.cricbuzz.com/cricket-match-facts/161256/sample-match",
      "https://www.cricbuzz.com/live-cricket-scorecard/161256/sample-match",
      "https://www.cricbuzz.com/cricket-match-squads/161256/sample-match",
      "https://www.cricbuzz.com/live-cricket-full-commentary/161256/sample-match"
    ];
    const pages = new Map<string, string>([
      [baseUrl, `<html><head><title>India vs New Zealand, 2nd Test</title></head><body><main>
        <h1>India vs New Zealand, 2nd Test</h1><p>Live cricket match</p>
        <a href="/cricket-match-facts/161256/sample-match">Info</a>
        <a href="/live-cricket-scorecard/161256/sample-match">Scorecard</a>
        <a href="/cricket-match-squads/161256/sample-match">Squads</a>
        <a href="/live-cricket-full-commentary/161256/sample-match">Commentary</a>
      </main></body></html>`],
      [companionUrls[0]!, "<html><body><main><h1>Match Facts</h1><p> Date &amp; Time 10 Nov 2026, 7:00 PM</p><p>Venue Trent Bridge</p><p>Toss India elected to bat</p></main></body></html>"],
      [companionUrls[1]!, "<html><body><main><h1>Full Scorecard</h1><p>India 200/3 (20 Ov)</p></main></body></html>"],
      [companionUrls[2]!, "<html><body><main><h1>Match Squads</h1><p>Selected players</p></main></body></html>"],
      [companionUrls[3]!, "<html><body><main><h1>Live Commentary</h1><p>Ball-by-ball commentary page</p></main></body></html>"]
    ]);
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = String(input);
      requested.push(requestUrl);
      const html = pages.get(requestUrl);
      return new Response(html ?? "not found", {
        status: html ? 200 : 404,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }));

    const provider = new CricbuzzProvider({
      minRequestIntervalMs: 0,
      maxMatchesPerPoll: 1,
      maxProfilesPerPoll: 0,
      maxTeamsPerPoll: 0,
      maxSeriesPerPoll: 0,
      maxVenuesPerPoll: 0,
      maxContentPagesPerPoll: 0,
      timeoutMs: 15_000,
      maxResponseBytes: 1_000_000,
      userAgent: "Crikora test runner (authorized test)"
    });

    const result = await provider.fetchCrawlPage(baseUrl);
    const payload = result.entity?.payload;

    expect(result.skipped).toBe(false);
    expect(result.entity).toMatchObject({ entityType: "match", sourceId: "161256" });
    expect(payload).toMatchObject({
      pageKind: "match-overview",
      infoUrl: companionUrls[0],
      scorecardUrl: companionUrls[1],
      squadsUrl: companionUrls[2],
      commentaryUrl: companionUrls[3],
      matchFacts: { title: "Match Facts" },
      scorecardPage: { title: "Full Scorecard" },
      squadPage: { title: "Match Squads" },
      commentaryPage: { title: "Live Commentary" },
      sourcePages: [baseUrl, ...companionUrls]
    });
    expect(requested).toEqual([baseUrl, ...companionUrls]);
    // Companion pages are already fetched, parsed and archived above. Do not
    // queue them again as separate follow-ups for the same match.
    expect(result.discoveredUrls).not.toEqual(expect.arrayContaining(companionUrls));
  });

  it("uses same-ID companion routes when the overview omits tab links", async () => {
    const baseUrl = "https://www.cricbuzz.com/live-cricket-scores/177291/india-vs-new-zealand";
    const factsUrl = "https://www.cricbuzz.com/cricket-match-facts/177291/india-vs-new-zealand";
    const expectedRequests = [
      baseUrl,
      factsUrl,
      "https://www.cricbuzz.com/live-cricket-scorecard/177291/india-vs-new-zealand",
      "https://www.cricbuzz.com/cricket-match-squads/177291/india-vs-new-zealand",
      "https://www.cricbuzz.com/live-cricket-full-commentary/177291/india-vs-new-zealand"
    ];
    const pages = new Map<string, string>([
      [baseUrl, "<html><body><main><h1>India vs New Zealand, 1st ODI</h1><p>Live</p></main></body></html>"],
      [factsUrl, "<html><body><main><h1>Verified Match Facts</h1><p> Date &amp; Time 10 Nov 2026, 1:00 PM</p><p>Venue Eden Gardens</p></main></body></html>"]
    ]);
    const requested: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = String(input);
      requested.push(requestUrl);
      const html = pages.get(requestUrl);
      return new Response(html ?? "not found", {
        status: html ? 200 : 404,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }));

    const provider = new CricbuzzProvider({
      minRequestIntervalMs: 0,
      maxMatchesPerPoll: 1,
      maxProfilesPerPoll: 0,
      maxTeamsPerPoll: 0,
      maxSeriesPerPoll: 0,
      maxVenuesPerPoll: 0,
      maxContentPagesPerPoll: 0,
      timeoutMs: 15_000,
      maxResponseBytes: 1_000_000,
      userAgent: "Crikora test runner (authorized test)"
    });

    const result = await provider.fetchCrawlPage(baseUrl);
    expect(requested).toEqual(expectedRequests);
    expect(result.entity?.payload.matchFacts).toMatchObject({ title: "Verified Match Facts" });
    expect(result.entity?.payload.sourcePages).toEqual([baseUrl, factsUrl]);
  });

  it("skips a live or upcoming match before the 4 November 2026 cutoff", async () => {
    const baseUrl = "https://www.cricbuzz.com/live-cricket-scores/160001/older-match";
    const factsUrl = "https://www.cricbuzz.com/cricket-match-facts/160001/older-match";
    const requested: string[] = [];
    const pages = new Map<string, string>([
      [baseUrl, "<html><body><main><h1>Team A vs Team B, 1st ODI</h1><p>Upcoming match scheduled</p></main></body></html>"],
      [factsUrl, "<html><body><main><h1>Match Facts</h1><p> Date &amp; Time 03 Nov 2026, 7:00 PM</p></main></body></html>"]
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const html = pages.get(url);
      return new Response(html ?? "not found", {
        status: html ? 200 : 404,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }));
    const provider = new CricbuzzProvider({
      minRequestIntervalMs: 0, maxMatchesPerPoll: 1, maxProfilesPerPoll: 0,
      maxTeamsPerPoll: 0, maxSeriesPerPoll: 0, maxVenuesPerPoll: 0,
      maxContentPagesPerPoll: 0, timeoutMs: 15_000, maxResponseBytes: 1_000_000,
      userAgent: "Crikora test runner (authorized test)"
    });

    const result = await provider.fetchCrawlPage(baseUrl);
    expect(result.skipped).toBe(true);
    expect(result.entity).toBeUndefined();
    expect(result.discoveredUrls).toEqual([]);
    expect(requested).toEqual([baseUrl, factsUrl]);
  });

  it("fails closed when a match date is not exposed", async () => {
    const baseUrl = "https://www.cricbuzz.com/live-cricket-scores/160002/undated-match";
    const factsUrl = "https://www.cricbuzz.com/cricket-match-facts/160002/undated-match";
    const requested: string[] = [];
    const pages = new Map<string, string>([
      [baseUrl, "<html><body><main><h1>Team A vs Team B, 1st ODI</h1><p>Live match</p></main></body></html>"],
      [factsUrl, "<html><body><main><h1>Match Facts</h1><p>Venue Somewhere</p></main></body></html>"]
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const html = pages.get(url);
      return new Response(html ?? "not found", {
        status: html ? 200 : 404,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }));
    const provider = new CricbuzzProvider({
      minRequestIntervalMs: 0, maxMatchesPerPoll: 1, maxProfilesPerPoll: 0,
      maxTeamsPerPoll: 0, maxSeriesPerPoll: 0, maxVenuesPerPoll: 0,
      maxContentPagesPerPoll: 0, timeoutMs: 15_000, maxResponseBytes: 1_000_000,
      userAgent: "Crikora test runner (authorized test)"
    });

    const result = await provider.fetchCrawlPage(baseUrl);
    expect(result.skipped).toBe(true);
    expect(result.entity).toBeUndefined();
    expect(result.discoveredUrls).toEqual([]);
    expect(requested).toEqual([baseUrl, factsUrl]);
  });

  it("queues only match links with visible dates on or after 4 November 2026", async () => {
    const indexUrl = "https://www.cricbuzz.com/cricket-match/live-scores";
    const oldMatch = "https://www.cricbuzz.com/live-cricket-scores/160003/old-match";
    const newMatch = "https://www.cricbuzz.com/live-cricket-scores/160004/new-match";
    const html = `<html><body><main>
      <div class="card"><div><div><a href="/live-cricket-scores/160003/old-match">Team A vs Team B</a><span>03 Nov 2026, 7:00 PM</span></div></div></div>
      <div class="card"><div><div><a href="/live-cricket-scores/160004/new-match">Team C vs Team D</a><span>04 Nov 2026, 7:00 PM</span></div></div></div>
    </main></body></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, {
      status: 200, headers: { "content-type": "text/html; charset=utf-8" }
    })));
    const provider = new CricbuzzProvider({
      minRequestIntervalMs: 0, maxMatchesPerPoll: 1, maxProfilesPerPoll: 0,
      maxTeamsPerPoll: 0, maxSeriesPerPoll: 0, maxVenuesPerPoll: 0,
      maxContentPagesPerPoll: 0, timeoutMs: 15_000, maxResponseBytes: 1_000_000,
      userAgent: "Crikora test runner (authorized test)"
    });

    const result = await provider.fetchCrawlPage(indexUrl);
    expect(result.discoveredUrls).toContain(newMatch);
    expect(result.discoveredUrls).not.toContain(oldMatch);
  });
});
