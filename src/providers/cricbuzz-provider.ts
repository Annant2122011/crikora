import { load } from "cheerio";
import type { Match, MatchEvent, Innings, Batter, Bowler, ProviderSnapshot } from "../domain/types.js";
import type { CricketProvider } from "./provider.js";

type Bucket = "live" | "upcoming" | "completed";
interface Options { minRequestIntervalMs: number; maxMatchesPerPoll: number; timeoutMs: number; userAgent: string; }

const ORIGIN = "https://www.cricbuzz.com";
const INDEXES: Array<{ path: string; bucket: Bucket }> = [
  { path: "/cricket-match/live-scores", bucket: "live" },
  { path: "/cricket-match/live-scores/upcoming-matches", bucket: "upcoming" },
  { path: "/cricket-match/live-scores/recent-matches", bucket: "completed" }
];

export class CricbuzzProvider implements CricketProvider {
  readonly id = "cricbuzz";
  private lastRequestAt = 0;
  constructor(private readonly options: Options) {}

  async fetchSnapshot(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const discovered = new Map<string, { path: string; bucket: Bucket }>();
    for (const index of INDEXES) {
      const $ = load(await this.getHtml(new URL(index.path, ORIGIN), signal));
      $("a[href*='/live-cricket-stream/']").each((_i, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const url = new URL(href, ORIGIN);
        const id = url.pathname.match(/^\/live-cricket-stream\/(\d+)(?:\/|$)/)?.[1];
        if (url.origin === ORIGIN && id && !discovered.has(id)) discovered.set(id, { path: url.pathname, bucket: index.bucket });
      });
    }

    const matches: Match[] = [];
    const events: MatchEvent[] = [];
    const candidates = [...discovered.entries()].slice(0, this.options.maxMatchesPerPoll);
    for (const [id, item] of candidates) {
      if (signal?.aborted) throw signal.reason ?? new Error("Collection aborted");
      const html = await this.getHtml(new URL(item.path, ORIGIN), signal);
      const $ = load(html);
      const scorecardHref = $("a[href*='/live-cricket-scorecard/']").first().attr("href");
      const scorecardHtml = scorecardHref
        ? await this.getHtml(new URL(scorecardHref, ORIGIN), signal)
        : html;
      const scorecard = load(scorecardHtml);
      const parsed = parseScorecard(scorecard, id, item.bucket);
      if (!parsed) continue;
      matches.push(parsed);
      if (item.bucket === "live") {
        const oversHref = $("a[href*='/live-cricket-over-by-over/']").first().attr("href")
          ?? $("a[href*='/live-cricket-overs/']").first().attr("href");
        if (oversHref) {
          const oversHtml = await this.getHtml(new URL(oversHref, ORIGIN), signal);
          events.push(...parseBallEvents(load(oversHtml), parsed));
        } else {
          events.push(...parseBallEvents($, parsed));
        }
      }
    }
    return { matches, events, fetchedAt: new Date().toISOString() };
  }

  private async getHtml(url: URL, signal?: AbortSignal): Promise<string> {
    if (url.origin !== ORIGIN || !/^\/(?:cricket-match\/|live-cricket-)/.test(url.pathname)) {
      throw new Error("Refusing to fetch a URL outside the Cricbuzz public-page allowlist.");
    }
    const wait = Math.max(0, this.options.minRequestIntervalMs - (Date.now() - this.lastRequestAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, {
      signal: combined,
      headers: { "user-agent": this.options.userAgent, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.8" },
      redirect: "manual"
    });
    if ([401, 403, 429].includes(response.status)) throw new Error(`Cricbuzz denied or throttled the request (HTTP ${response.status}); collector stopped.`);
    if (response.status >= 300 && response.status < 400) throw new Error(`Unexpected Cricbuzz redirect (HTTP ${response.status}); refusing to follow it.`);
    if (!response.ok) throw new Error(`Cricbuzz returned HTTP ${response.status} for ${url.pathname}`);
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) throw new Error("Cricbuzz returned a non-HTML response.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 8_000_000) throw new Error("Cricbuzz page exceeded the 8 MB safety limit.");
    const html = new TextDecoder().decode(bytes);
    if (/captcha|robot check|access denied/i.test(html.slice(0, 100_000))) throw new Error("Cricbuzz presented an access challenge; collector stopped without bypassing it.");
    return html;
  }
}

function parseScorecard($: ReturnType<typeof load>, id: string, bucket: Bucket): Match | null {
  const title = clean($("h1").first().text() || $("title").text()).replace(/\s*[-|].*$/, "").trim();
  const teams = title.match(/^(.+?)\s+vs\s+(.+?)(?:,|$)/i);
  if (!teams) return null;
  const body = clean($("body").text());
  const now = new Date().toISOString();
  const homeTeam = teams[1]!.trim();
  const awayTeam = teams[2]!.trim();
  const innings = parseInnings($, id, homeTeam, awayTeam);
  const format = /\btest\b/i.test(title) ? "Test" : /\bodi\b/i.test(title) ? "ODI" : /\bt20\b/i.test(title) ? "T20" : "Unknown";
  const venue = body.match(/Venue\s+(.+?)\s+Date(?:\s|$)/i)?.[1]?.trim();
  const competition = title.split(",").slice(1).join(",").trim() || "Cricket";
  return {
    id: `cricbuzz:${id}`, source: "cricbuzz", sourceMatchId: id, competition,
    homeTeam, awayTeam, status: bucket, format, startTime: now, venue,
    description: title, innings, updatedAt: now
  };
}

function parseInnings($: ReturnType<typeof load>, id: string, home: string, away: string): Innings[] {
  const result: Innings[] = [];
  const ordered = $("div.cb-col-100.cb-scrd-hdr-rw, div.cb-col.cb-col-100.cb-scrd-hdr-rw, div.cb-col-100.cb-scrd-itms, div.cb-col.cb-col-100.cb-scrd-itms").toArray();
  let current: Innings | undefined;
  let index = -1;
  const teamFor = (i: number) => i === 0 ? home : i === 1 ? away : `Innings ${i + 1}`;
  for (const element of ordered) {
    const row = $(element);
    const text = clean(row.text());
    const cols = row.children().toArray().map(el => clean($(el).text()));
    if (/^Batter\b/i.test(text) || /^Bowler\b/i.test(text)) continue;

    // Each innings starts with a team/score header, for example "BIK 83-10 (18.3 Ov)".
    if (/^[A-Z0-9]{2,8}\s+\d{1,3}[-/]\d{1,2}\s*\(/.test(text)) {
      index += 1;
      const teamName = teamFor(index);
      current = {
        id: `${id}:innings:${index + 1}`, teamId: slug(teamName), teamName,
        runs: 0, wickets: 0, overs: "0", batters: [], bowlers: []
      };
      result.push(current);
      const score = text.match(/(\d{1,3})[-/](\d{1,2})\s*\((\d+(?:\.\d+)?)\s*Ov/i);
      if (score) { current.runs = number(score[1]); current.wickets = number(score[2]); current.overs = score[3]!; }
      continue;
    }
    if (!current || cols.length < 4) continue;
    const name = cols[0] ?? "";
    if (/^Total$/i.test(name)) {
      const total = cols.join(" ").match(/(\d{1,3})[-/](\d{1,2})\s*\((\d+(?:\.\d+)?)\s*Overs?/i);
      if (total) { current.runs = number(total[1]); current.wickets = number(total[2]); current.overs = total[3]!; }
      continue;
    }
    if (/^(Extras|Fall of Wickets|Powerplays|Partnerships|Yet to Bat)$/i.test(name)) continue;
    if (/^\d+(?:\.\d+)?$/.test(cols[1] ?? "") && /^\d+$/.test(cols[2] ?? "") && /^\d+$/.test(cols[3] ?? "")) {
      current.bowlers.push({
        id: slug(name), name: name.replace(/\s*\(.*?\)$/, ""),
        overs: cols[1]!, runs: number(cols[3]), wickets: number(cols[4])
      });
    } else if (/^\d+$/.test(cols[2] ?? "") && /^\d+$/.test(cols[3] ?? "")) {
      current.batters.push({
        id: slug(name), name: name.replace(/\s*\(.*?\)$/, ""),
        runs: number(cols[2]), balls: number(cols[3]), fours: number(cols[4]), sixes: number(cols[5]),
        out: !/not out|batting/i.test(cols.join(" "))
      });
    }
  }
  return result.filter(innings => innings.batters.length > 0);
}

function parseBallEvents($: ReturnType<typeof load>, match: Match): MatchEvent[] {
  const text = clean($("body").text());
  const segments = text.split(/(?=Ov\\s+\\d+\\s+\\d+[-/]\\d+)/);
  const events: MatchEvent[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const heading = segment.match(/^Ov\\s+(\\d+)\\s+\\d+[-/]\\d+/);
    if (!heading) continue;
    const over = heading[1]!;
    const ballText = segment.split(/\\bto\\b/i).slice(1).join(" to ");
    const tokens = [...ballText.matchAll(/(?:^|\\s)(W|4|6)(?=\\s|$)/g)].map(match => match[1]!);
    tokens.forEach((token, ballIndex) => {
      const type: MatchEvent["type"] = token === "W" ? "wicket" : token === "6" ? "six" : "four";
      const sourceEventId = `${match.id}:${over}:ball:${ballIndex}:${type}`;
      if (seen.has(sourceEventId)) return;
      seen.add(sourceEventId);
      const innings = match.innings.at(-1);
      events.push({
        id: sourceEventId, sourceEventId, matchId: match.id,
        inningsId: innings?.id ?? `${match.id}:innings:1`,
        type, teamName: innings?.teamName ?? "",
        summary: token === "W" ? `Wicket in over ${over}` : `${token} in over ${over}`,
        over, occurredAt: match.updatedAt
      });
    });
  }
  return events;
}

function clean(value: string): string { return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function number(value: string | undefined): number {
  const parsed = Number.parseFloat((value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
