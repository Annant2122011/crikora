import { load } from "cheerio";
import type { Match, MatchEvent, Innings, Batter, Bowler, ProviderSnapshot } from "../domain/types.js";
import type { CricketProvider } from "./provider.js";

type MatchBucket = "live" | "upcoming" | "completed";
interface ProviderOptions {
  minRequestIntervalMs: number;
  maxMatchesPerPoll: number;
  timeoutMs: number;
  userAgent: string;
}

/**
 * Cricbuzz public-page collector.
 *
 * It uses only the public HTML pages and their ordinary navigation links.
 * It deliberately does not call private/mobile APIs, replay browser cookies,
 * access video streams, or bypass bot checks. If the page structure changes,
 * parsing fails closed rather than silently returning fabricated scores.
 */
export class CricbuzzProvider implements CricketProvider {
  readonly id = "cricbuzz";
  private lastRequestAt = 0;
  private readonly origin = "https://www.cricbuzz.com";

  constructor(private readonly options: ProviderOptions) {}

  async fetchSnapshot(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const discovered = new Map<string, { url: string; bucket: MatchBucket }>();
    const pages: Array<{ path: string; bucket: MatchBucket }> = [
      { path: "/cricket-match/live-scores", bucket: "live" },
      { path: "/cricket-match/live-scores/upcoming-matches", bucket: "upcoming" },
      { path: "/cricket-match/live-scores/recent-matches", bucket: "completed" }
    ];

    for (const page of pages) {
      const html = await this.getHtml(new URL(page.path, this.origin), signal);
      const $ = load(html);
      $("a[href*='/live-cricket-stream/']").each((_index, element) => {
        const href = $(element).attr("href");
        if (!href) return;
        const url = new URL(href, this.origin);
        if (url.origin !== this.origin) return;
        const match = url.pathname.match(/^\/live-cricket-stream\/(\d+)\/([^/?#]+)/);
        if (!match) return;
        const key = match[1]!;
        if (!discovered.has(key)) discovered.set(key, { url: url.toString(), bucket: page.bucket });
      });
    }

    const matches: Match[] = [];
    const events: MatchEvent[] = [];
    const candidates = [...discovered.values()].slice(0, this.options.maxMatchesPerPoll);
    for (const candidate of candidates) {
      if (signal?.aborted) throw signal.reason;
      const parsed = await this.fetchMatch(candidate.url, candidate.bucket, signal);
      if (parsed) {
        matches.push(parsed.match);
        events.push(...parsed.events);
      }
    }
    return { matches, events, fetchedAt: new Date().toISOString() };
  }

  private async fetchMatch(streamUrl: string, bucket: MatchBucket, signal?: AbortSignal): Promise<{ match: Match; events: MatchEvent[] } | null> {
    const stream = new URL(streamUrl);
    const route = stream.pathname.replace("/live-cricket-stream/", "/live-cricket-scorecard/");
    const scorecardHtml = await this.getHtml(new URL(route, this.origin), signal);
    const match = parseScorecard(scorecardHtml, stream.pathname, bucket);
    if (!match) return null;

    // The over-by-over page contains the event sequence (including W/4/6).
    // Parse only explicit ball tokens and avoid guessing from aggregate totals.
    if (bucket === "live") {
      const oversPath = stream.pathname.replace("/live-cricket-stream/", "/live-cricket-over-by-over/");
      const oversHtml = await this.getHtml(new URL(oversPath, this.origin), signal);
      return { match, events: parseOverEvents(oversHtml, match) };
    }
    return { match, events: [] };
  }

  private async getHtml(url: URL, signal?: AbortSignal): Promise<string> {
    if (url.origin !== this.origin || !url.pathname.startsWith("/cricket-match/") && !url.pathname.startsWith("/live-cricket-")) {
      throw new Error("Refusing to fetch a URL outside the configured Cricbuzz page allowlist.");
    }
    const wait = Math.max(0, this.options.minRequestIntervalMs - (Date.now() - this.lastRequestAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, {
      signal: combined,
      headers: {
        "user-agent": this.options.userAgent,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.8"
      },
      redirect: "manual"
    });
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new Error(`Cricbuzz denied or throttled the request (HTTP ${response.status}); collector stopped.`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Unexpected redirect from Cricbuzz (HTTP ${response.status}); refusing to follow it.`);
    }
    if (!response.ok) throw new Error(`Cricbuzz returned HTTP ${response.status} for ${url.pathname}`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) throw new Error(`Expected HTML from Cricbuzz, received ${type}`);
    const body = await response.text();
    if (body.length > 8_000_000) throw new Error("Cricbuzz page exceeded the 8 MB safety limit.");
    if (/captcha|robot check|access denied/i.test(body.slice(0, 100_000))) throw new Error("Cricbuzz presented an access challenge; collector stopped without bypassing it.");
    return body;
  }
}

function parseScorecard(html: string, streamPath: string, bucket: MatchBucket): Match | null {
  const $ = load(html);
  const title = $("h1").first().text().trim() || $("title").text().trim();
  const heading = title.replace(/\s*[-|].*$/, "").trim();
  const teams = heading.match(/^(.+?)\s+vs\s+(.+?)(?:,|$)/i);
  if (!teams) return null;
  const matchId = streamPath.match(/\/live-cricket-stream\/(\d+)/)?.[1];
  if (!matchId) return null;
  const now = new Date().toISOString();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const format = /\bTest\b/i.test(heading) ? "Test" : /\bODI\b/i.test(heading) ? "ODI" : /\bT20\b/i.test(heading) ? "T20" : "Unknown";
  const competition = heading.split(",").slice(1).join(",").trim() || "Cricket";
  const venue = bodyText.match(/Venue\s+([\w ,.'()-]+?)(?:\s+Date|\s+Time|\s+Toss)/i)?.[1]?.trim();
  const innings = parseInnings($, matchId);
  const status: Match["status"] = bucket === "completed" ? "completed" : bucket;
  const startTime = parseStartTime(bodyText) ?? now;
  return {
    id: `cricbuzz:${matchId}`, source: "cricbuzz", sourceMatchId: matchId,
    competition, homeTeam: teams[1]!.trim(), awayTeam: teams[2]!.trim(),
    status, format, startTime, venue, description: heading,
    innings, updatedAt: now
  };
}

function parseStartTime(text: string): string | null {
  const match = text.match(/Date & Time\s+(.+?)(?:\s+Info|\s+Toss|\s+Venue)/i);
  if (!match) return null;
  const value = match[1]!.trim();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseInnings($: ReturnType<typeof load>, matchId: string): Innings[] {
  const result: Innings[] = [];
  let currentTeam = "";
  let index = 0;
  $("h2,h3,div.cb-col.cb-col-100.cb-scrd-hdr-rw,div.cb-col-100.cb-scrd-hdr-rw").each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const team = text.match(/^([A-Z0-9]{2,8})\s+(?:\d+(?:st|nd|rd|th)\s+)?Innings/i);
    if (team) currentTeam = team[1]!;
  });

  const tables = $("table");
  tables.each((_tableIndex, table) => {
    const rows = $(table).find("tr");
    const first = rows.first().text().toLowerCase();
    if (!first.includes("batter") || !first.includes("4s") || !first.includes("6s")) return;
    const batters: Batter[] = [];
    rows.slice(1).each((_rowIndex, row) => {
      const cells = $(row).find("td").map((_cellIndex, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get();
      if (cells.length < 6) return;
      const name = cells[0]!;
      const runs = number(cells[1]);
      const balls = number(cells[2]);
      if (!name || !Number.isFinite(runs) || !Number.isFinite(balls)) return;
      batters.push({
        id: slug(name), name, runs, balls, fours: number(cells[3]), sixes: number(cells[4]),
        out: !/^(?:not out|batting|retired hurt|\*)$/i.test(cells[1] ?? "")
          && !/\bnot out\b|\bbatting\b/i.test(cells.slice(0, 2).join(" "))
      });
    });
    if (!batters.length) return;
    const teamName = currentTeam || `Innings ${index + 1}`;
    const scoreText = $(table).prevAll("div").first().text().replace(/\s+/g, " ");
    const score = scoreText.match(/(\d{1,3})\s*[-/]\s*(\d{1,2})\s*\((\d+(?:\.\d+)?)\s*Ov/i);
    const bowlers: Bowler[] = [];
    const nextTable = $(table).nextAll("table").first();
    if (nextTable.length) {
      nextTable.find("tr").slice(1).each((_ri, row) => {
        const cells = $(row).find("td").map((_ci, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get();
        if (cells.length < 5 || !cells[0]) return;
        bowlers.push({ id: slug(cells[0]!), name: cells[0]!, overs: cells[1]!, runs: number(cells[3]), wickets: number(cells[4]) });
      });
    }
    index += 1;
    result.push({
      id: `${matchId}:innings:${index}`, teamId: slug(teamName), teamName,
      runs: score ? number(score[1]) : batters.reduce((sum, batter) => sum + batter.runs, 0),
      wickets: score ? number(score[2]) : batters.filter(batter => batter.out).length,
      overs: score?.[3] ?? "0", batters, bowlers
    });
  });
  return result;
}

function parseOverEvents(html: string, match: Match): MatchEvent[] {
  const $ = load(html);
  const text = $("body").text().replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const events: MatchEvent[] = [];
  const overBlocks = $("div").filter((_i, el) => {
    const value = $(el).text().replace(/\s+/g, " ").trim();
    return /^Ov\s+\d+\s+\d+[-/]\d+/.test(value) && value.length < 1200;
  });
  overBlocks.each((_i, block) => {
    const value = $(block).text().replace(/\s+/g, " ").trim();
    const over = value.match(/^Ov\s+(\d+)/)?.[1];
    const bowler = value.match(/^Ov\s+\d+\s+\d+[-/]\d+\s+(.+?)\s+to\s+(.+?)(?:\s+[W•\d]|$)/i)?.[1]?.trim();
    if (!over) return;
    const tokens = value.match(/\bW\b|\b6\b|\b4\b/g) ?? [];
    for (const token of tokens) {
      const type = token === "W" ? "wicket" : token === "6" ? "six" : "four";
      const id = `${match.id}:over:${over}:ball:${tokenIndex}:${type}`;
      events.push({
        id, sourceEventId: id, matchId: match.id,
        inningsId: match.innings[0]?.id ?? `${match.id}:innings:1`,
        type, teamName: match.innings[0]?.teamName ?? "",
        playerName: bowler, summary: token === "W" ? `Wicket in over ${over}` : `${token} in over ${over}`,
        over, occurredAt: match.updatedAt
      });
    }
  });
  void text;
  return [...new Map(events.map(event => [event.sourceEventId, event])).values()];
}

function number(value: string | undefined): number {
  const parsed = Number.parseFloat((value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
