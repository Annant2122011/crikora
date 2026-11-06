import { load, type CheerioAPI } from "cheerio";
import type { CrikoraEntity, EntityType } from "../domain/entities.js";
import type { EventType, Match, MatchEvent, MatchStatus, ProviderSnapshot } from "../domain/types.js";
import type { CricketProvider } from "./provider.js";

type MatchBucket = "live" | "upcoming" | "completed";
type PageDoc = CheerioAPI;
interface Options {
  minRequestIntervalMs: number;
  maxMatchesPerPoll: number;
  maxProfilesPerPoll: number;
  maxTeamsPerPoll: number;
  maxSeriesPerPoll: number;
  maxVenuesPerPoll: number;
  timeoutMs: number;
  maxResponseBytes: number;
  userAgent: string;
}
interface DiscoveredMatch { id: string; path: string; bucket: MatchBucket; }
interface PageRecord { url: string; html: string; $: PageDoc; }
interface LinkRecord { url: string; path: string; text: string; }

const ORIGIN = "https://www.cricbuzz.com";
const IMAGE_HOSTS = new Set(["www.cricbuzz.com", "static.cricbuzz.com", "img.cricbuzz.com"]);
const INDEXES: Array<{ path: string; bucket: MatchBucket }> = [
  { path: "/cricket-match/live-scores", bucket: "live" },
  { path: "/cricket-match/live-scores/upcoming-matches", bucket: "upcoming" },
  { path: "/cricket-match/live-scores/recent-matches", bucket: "completed" }
];
const PATH_RULES: Array<{ type: EntityType; pattern: RegExp }> = [
  { type: "player", pattern: /^\/profiles\/(\d+)(?:\/|$)/ },
  { type: "team", pattern: /^\/cricket-team\/([^/]+)\/(\d+)(?:\/|$)/ },
  { type: "venue", pattern: /^\/cricket-series\/\d+\/[^/]+\/venues\/(\d+)(?:\/|$)/ },
  { type: "series", pattern: /^\/cricket-series\/(\d+)(?:\/|$)/ }
];

export class CricbuzzProvider implements CricketProvider {
  readonly id = "cricbuzz";
  private lastRequestAt = 0;
  private matchCursor = 0;

  constructor(private readonly options: Options) {
    if (!Number.isInteger(options.minRequestIntervalMs) || options.minRequestIntervalMs < 1000) {
      throw new Error("Cricbuzz request interval must be at least 1000ms.");
    }
    if (options.maxMatchesPerPoll < 1 || options.maxMatchesPerPoll > 50) throw new Error("Invalid maxMatchesPerPoll.");
  }

  async fetchSnapshot(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const discovered = new Map<string, DiscoveredMatch>();
    for (const index of INDEXES) {
      const page = await this.fetchPage(new URL(index.path, ORIGIN), signal);
      for (const link of getLinks(page.$, page.url)) {
        const match = link.path.match(/^\/live-cricket-scores\/(\d+)(?:\/|$)/);
        if (match?.[1] && !discovered.has(match[1])) {
          discovered.set(match[1], { id: match[1], path: link.path, bucket: index.bucket });
        }
      }
    }

    const allMatches = [...discovered.values()];
    const selected = rotate(allMatches, this.matchCursor, this.options.maxMatchesPerPoll);
    if (allMatches.length) this.matchCursor = (this.matchCursor + selected.length) % allMatches.length;

    const matches: Match[] = [];
    const events: MatchEvent[] = [];
    const entities = new Map<string, CrikoraEntity>();
    const profileLinks = new Map<string, LinkRecord>();
    const teamLinks = new Map<string, LinkRecord>();
    const seriesLinks = new Map<string, LinkRecord>();
    const venueLinks = new Map<string, LinkRecord>();

    for (const discoveredMatch of selected) {
      if (signal?.aborted) throw signal.reason ?? new Error("Cricbuzz collection aborted.");
      const base = await this.fetchPage(new URL(discoveredMatch.path, ORIGIN), signal);
      const navigation = collectMatchNavigation(base.$, base.url, discoveredMatch.id);
      const info = navigation.info ? await this.fetchPage(new URL(navigation.info, ORIGIN), signal) : undefined;
      const scorecard = navigation.scorecard ? await this.fetchPage(new URL(navigation.scorecard, ORIGIN), signal) : undefined;
      const squads = navigation.squads ? await this.fetchPage(new URL(navigation.squads, ORIGIN), signal) : undefined;
      const commentary = navigation.commentary ? await this.fetchPage(new URL(navigation.commentary, ORIGIN), signal) : undefined;

      const match = parseMatch(discoveredMatch, base, info, scorecard);
      const matchEvents = commentary ? parseEvents(commentary.$, match) : parseEvents(base.$, match);
      match.events = matchEvents;
      matches.push(match);
      events.push(...matchEvents);

      const combinedPages = [base, info, scorecard, squads, commentary].filter((p): p is PageRecord => Boolean(p));
      const payload = {
        ...match,
        matchFacts: info ? extractPageData(info.$, info.url) : null,
        scorecard: scorecard ? extractPageData(scorecard.$, scorecard.url) : null,
        squadPage: squads ? extractPageData(squads.$, squads.url) : null,
        commentary: commentary ? extractPageData(commentary.$, commentary.url) : null,
        sourcePages: combinedPages.map(page => page.url)
      };
      addEntity(entities, "match", discoveredMatch.id, base.url, payload);

      for (const page of combinedPages) {
        const related = collectRelatedLinks(page.$, page.url);
        mergeLinks(profileLinks, related.profiles);
        mergeLinks(teamLinks, related.teams);
        mergeLinks(seriesLinks, related.series);
        mergeLinks(venueLinks, related.venues);
        const generic = parseEntityPage(page.$, page.url);
        if (generic) addEntity(entities, generic.entityType, generic.sourceId, generic.sourceUrl, generic.payload);
      }
    }

    await this.fetchRelatedEntities(profileLinks, this.options.maxProfilesPerPoll, "player", entities, signal);
    await this.fetchRelatedEntities(teamLinks, this.options.maxTeamsPerPoll, "team", entities, signal);
    await this.fetchRelatedEntities(seriesLinks, this.options.maxSeriesPerPoll, "series", entities, signal);
    await this.fetchRelatedEntities(venueLinks, this.options.maxVenuesPerPoll, "venue", entities, signal);

    const fetchedAt = new Date().toISOString();
    return { matches, events, entities: [...entities.values()], fetchedAt };
  }

  private async fetchRelatedEntities(
    links: Map<string, LinkRecord>,
    limit: number,
    expectedType: EntityType,
    entities: Map<string, CrikoraEntity>,
    signal?: AbortSignal
  ): Promise<void> {
    if (!limit || !links.size) return;
    const candidates = [...links.values()].slice(0, limit);
    for (const link of candidates) {
      if (signal?.aborted) throw signal.reason ?? new Error("Cricbuzz collection aborted.");
      const page = await this.fetchPage(new URL(link.url), signal);
      const parsed = parseEntityPage(page.$, page.url, expectedType);
      if (parsed) addEntity(entities, parsed.entityType, parsed.sourceId, parsed.sourceUrl, parsed.payload);
    }
  }

  private async fetchPage(url: URL, signal?: AbortSignal): Promise<PageRecord> {
    assertAllowedPageUrl(url);
    const waitMs = Math.max(0, this.options.minRequestIntervalMs - (Date.now() - this.lastRequestAt));
    if (waitMs) await delay(waitMs, signal);
    this.lastRequestAt = Date.now();

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, {
      signal: combined,
      headers: {
        "user-agent": this.options.userAgent,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.8"
      },
      redirect: "manual"
    });
    if ([401, 403, 429].includes(response.status)) {
      throw new Error(`Cricbuzz denied or throttled ${url.pathname} (HTTP ${response.status}). Stop and respect the source response.`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Cricbuzz redirected ${url.pathname} (HTTP ${response.status}); automatic redirect following is disabled.`);
    }
    if (!response.ok) throw new Error(`Cricbuzz returned HTTP ${response.status} for ${url.pathname}`);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
      throw new Error(`Expected HTML from Cricbuzz at ${url.pathname}.`);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > this.options.maxResponseBytes) throw new Error(`Cricbuzz page exceeded ${this.options.maxResponseBytes} bytes.`);
    const html = new TextDecoder().decode(body);
    if (/captcha|robot check|access denied|unusual traffic/i.test(html.slice(0, 100_000))) {
      throw new Error("Cricbuzz presented an access challenge; the collector stopped without bypassing it.");
    }
    return { url: url.toString(), html, $: load(html) };
  }
}

function assertAllowedPageUrl(url: URL): void {
  if (url.protocol !== "https:" || url.hostname !== "www.cricbuzz.com" || url.username || url.password) {
    throw new Error("Refusing to request a non-Cricbuzz or non-HTTPS page.");
  }
  const allowed = /^\/(?:cricket-match\/|live-cricket-|profiles\/|cricket-team\/|cricket-series\/)/.test(url.pathname);
  if (!allowed) throw new Error(`Page path is outside the Cricbuzz crawler allowlist: ${url.pathname}`);
}

function collectMatchNavigation($: PageDoc, pageUrl: string, matchId: string): {
  info?: string; scorecard?: string; squads?: string; commentary?: string;
} {
  const found: { info?: string; scorecard?: string; squads?: string; commentary?: string } = {};
  for (const link of getLinks($, pageUrl)) {
    if (!new RegExp(`/${matchId}(?:/|$)`).test(link.path)) continue;
    if (link.path.startsWith("/cricket-match-facts/")) found.info ??= link.url;
    if (link.path.startsWith("/live-cricket-scorecard/")) found.scorecard ??= link.url;
    if (link.path.startsWith("/cricket-match-squads/")) found.squads ??= link.url;
    if (link.path.startsWith("/live-cricket-full-commentary/")) found.commentary ??= link.url;
  }
  return found;
}

function parseMatch(discovered: DiscoveredMatch, base: PageRecord, info?: PageRecord, scorecard?: PageRecord): Match {
  const $ = base.$;
  const title = clean($("h1").first().text() || $("title").text()).replace(/\s+-\s+(?:Commentary|Live|Scorecard).*$/i, "");
  const pair = title.match(/^(.+?)\s+vs\s+(.+?)(?:,|$)/i);
  const body = getMainText($);
  const infoText = info ? getMainText(info.$) : "";
  const scoreText = scorecard ? getMainText(scorecard.$) : body;
  const homeTeam = clean(pair?.[1] ?? "") || "Unknown";
  const awayTeam = clean(pair?.[2] ?? "") || "Unknown";
  const now = new Date().toISOString();
  const innings = parseScorecard(scorecard?.$, discovered.id, homeTeam, awayTeam);
  const competition = title.split(",").slice(1).join(",").trim().replace(/\s+-\s+.*$/, "") || "Cricket";
  const seriesLink = getLinks($, base.url).find(link => link.path.startsWith("/cricket-series/"));
  const venueLink = getLinks(info?.$ ?? $, info?.url ?? base.url).find(link => /\/venues\/\d+/.test(link.path));
  const venueText = labeledValue(infoText || body, "Venue");
  const dateTimeText = labeledValue(infoText || body, "Time") || labeledValue(infoText || body, "Date & Time");
  const toss = labeledValue(infoText || body, "Toss");
  const result = body.match(/([A-Za-z0-9 .'-]+ won by [^.]+|Match abandoned[^.]*|Match drawn|Match tied|No result)/i)?.[1]?.trim();
  const status: MatchStatus = result || discovered.bucket === "completed" ? "completed" : discovered.bucket;
  const format = /the hundred/i.test(title) ? "The Hundred" : /test/i.test(title) ? "Test" : /odi/i.test(title) ? "ODI" : /t20/i.test(title) ? "T20" : "Unknown";
  const images = extractImages($);
  return {
    id: `cricbuzz:${discovered.id}`, source: "cricbuzz", sourceMatchId: discovered.id,
    competition, homeTeam, awayTeam, status, format, startTime: parseDateTime(dateTimeText) ?? "",
    venue: venueLink?.text || venueText || undefined, description: title, innings, updatedAt: now,
    sourceUrl: base.url, infoUrl: info?.url, scorecardUrl: scorecard?.url,
    squadsUrl: getLinks(base.$, base.url).find(l => l.path.startsWith("/cricket-match-squads/"))?.url,
    commentaryUrl: getLinks(base.$, base.url).find(l => l.path.startsWith("/live-cricket-full-commentary/"))?.url,
    toss: toss || undefined, result,
    stats: { liveSummary: body.slice(0, 5000), scorecardText: scoreText.slice(0, 12000), infoText: infoText.slice(0, 12000) },
    images,
    officials: info ? extractLabels(info.$) : undefined,
    squads: undefined,
    events: []
  };
}

function parseScorecard($: PageDoc | undefined, matchId: string, home: string, away: string): Match["innings"] {
  if (!$) return [];
  const innings: Match["innings"] = [];
  const containers = $("div.cb-col-100.cb-scrd-hdr-rw, div.cb-col.cb-col-100.cb-scrd-hdr-rw, div.cb-col-100.cb-scrd-itms, div.cb-col.cb-col-100.cb-scrd-itms, table tr").toArray();
  let current: Match["innings"][number] | undefined;
  let index = 0;
  let mode: "batting" | "bowling" = "batting";
  for (const node of containers) {
    const row = $(node);
    const value = clean(row.text());
    const cols = row.is("tr")
      ? row.find("th,td").toArray().map(el => clean($(el).text()))
      : row.children().toArray().map(el => clean($(el).text()));
    if (/^Batter\b/i.test(value)) { mode = "batting"; continue; }
    if (/^Bowler\b/i.test(value)) { mode = "bowling"; continue; }
    const header = value.match(/^([A-Z0-9]{2,10})\s+(\d{1,3})[-/](\d{1,2})\s*\((\d+(?:\.\d+)?)\s*(Ov|Overs?|Balls?)/i);
    if (header) {
      index += 1;
      const teamName = index === 1 ? home : index === 2 ? away : header[1]!;
      current = {
        id: `${matchId}:innings:${index}`, teamId: slug(teamName), teamName,
        runs: num(header[2]), wickets: num(header[3]), overs: header[4]!, batters: [], bowlers: []
      };
      innings.push(current);
      mode = "batting";
      continue;
    }
    if (!current || cols.length < 4) continue;
    const first = cols[0] ?? "";
    if (/^Total$/i.test(first)) {
      const total = value.match(/(\d{1,3})[-/](\d{1,2})\s*\((\d+(?:\.\d+)?)\s*(?:Ov|Overs?)/i);
      if (total) { current.runs = num(total[1]); current.wickets = num(total[2]); current.overs = total[3]!; }
      continue;
    }
    if (/^(Extras|Fall of Wickets|Powerplays|Partnerships|Yet to Bat)$/i.test(first)) continue;
    if (mode === "bowling" && /^\d+(?:\.\d+)?$/.test(cols[1] ?? "") && /^\d+$/.test(cols[2] ?? "")) {
      current.bowlers.push({
        id: slug(first), name: first, overs: cols[1]!,
        runs: num(cols[3]), wickets: num(cols[4])
      });
    } else if (mode === "batting") {
      const hasDismissal = /^\d+$/.test(cols[2] ?? "") && /^\d+$/.test(cols[3] ?? "");
      const simpleRow = /^\d+$/.test(cols[1] ?? "") && /^\d+$/.test(cols[2] ?? "");
      if (hasDismissal) {
        current.batters.push({
          id: slug(first), name: first, runs: num(cols[2]), balls: num(cols[3]),
          fours: num(cols[4]), sixes: num(cols[5]), out: !/not out|batting/i.test(value)
        });
      } else if (simpleRow) {
        current.batters.push({
          id: slug(first), name: first, runs: num(cols[1]), balls: num(cols[2]),
          fours: num(cols[3]), sixes: num(cols[4]), out: !/not out|batting/i.test(value)
        });
      }
    }
  }
  return innings;
}

function parseEvents($: PageDoc, match: Match): MatchEvent[] {
  const candidates = $("div,li,p").toArray().map(el => clean($(el).text()))
    .filter(text => text.length >= 20 && text.length <= 800 && /\bto\b/i.test(text) &&
      /\b(FOUR|SIX|out|wicket|no run|no ball|wide)\b/i.test(text));
  const unique = [...new Set(candidates)];
  const events: MatchEvent[] = [];
  for (const text of unique) {
    let type: EventType | undefined;
    if (/\b(out|wicket|bowled|lbw|caught|run out|stumped|hit wicket)\b/i.test(text)) type = "wicket";
    else if (/\bSIX\b/i.test(text)) type = "six";
    else if (/\bFOUR\b/i.test(text)) type = "four";
    if (!type) continue;
    const delivery = text.match(/\b(\d{1,2}\.\d|\d{1,3})\b/)?.[1];
    const sourceEventId = `${match.id}:${type}:${stableHash(text)}`;
    events.push({
      id: sourceEventId, sourceEventId, matchId: match.id,
      inningsId: match.innings.at(-1)?.id ?? `${match.id}:innings:1`,
      type, teamName: match.innings.at(-1)?.teamName ?? "",
      playerName: text.match(/^(.+?)\s+to\s+/i)?.[1]?.trim(),
      summary: text.slice(0, 300), over: delivery, occurredAt: new Date().toISOString()
    });
  }
  return events.slice(0, 250);
}

function parseEntityPage($: PageDoc, url: string, expected?: EntityType): CrikoraEntity | undefined {
  const path = new URL(url).pathname;
  const rule = PATH_RULES.find(item => item.pattern.test(path));
  const entityType = expected ?? rule?.type;
  if (!entityType) return undefined;
  const match = rule?.pattern.exec(path);
  const sourceId = match?.[2] && entityType === "team" ? match[2]
    : match?.[1] ?? `${entityType}:${stableHash(path)}`;
  const data = extractPageData($, url);
  const payload: Record<string, unknown> = {
    ...data,
    entityType,
    name: data.title ?? data.heading ?? new URL(url).pathname.split("/").filter(Boolean).at(-1),
    profile: entityType === "player" ? extractPlayerDetails($) : undefined,
    statistics: data.tables,
    associations: getLinks($, url).filter(link => /profiles|cricket-team|cricket-series/.test(link.path))
  };
  return { entityType, sourceId, sourceUrl: url, payload, fetchedAt: new Date().toISOString() };
}

function extractPageData($: PageDoc, url: string): Record<string, unknown> {
  const title = clean($("h1").first().text() || $("title").text());
  const mainText = getMainText($);
  return {
    title,
    canonicalUrl: $("link[rel='canonical']").attr("href") || url,
    meta: extractMeta($),
    images: extractImages($),
    links: getLinks($, url).slice(0, 500),
    labels: extractLabels($),
    tables: extractTables($),
    sections: extractSections($),
    structuredData: extractStructuredData($),
    text: mainText.slice(0, 30000)
  };
}

function extractMeta($: PageDoc): Record<string, string> {
  const meta: Record<string, string> = {};
  $("meta[name],meta[property]").each((_i, el) => {
    const key = $(el).attr("property") || $(el).attr("name");
    const value = $(el).attr("content");
    if (key && value) meta[key] = clean(value);
  });
  return meta;
}
function extractImages($: PageDoc): Array<{ url: string; alt?: string; width?: number; height?: number }> {
  const map = new Map<string, { url: string; alt?: string; width?: number; height?: number }>();
  $("img").each((_i, el) => {
    const node = $(el);
    const src = node.attr("data-src") || node.attr("data-original") || node.attr("data-lazy-src") || node.attr("src");
    if (!src || /^data:/i.test(src)) return;
    const candidates = [src, ...(node.attr("srcset") ?? "").split(",").map(item => item.trim().split(/\s+/)[0] ?? "")];
    for (const candidate of candidates) {
      try {
        const parsed = new URL(candidate, ORIGIN);
        if (!/^https?:$/.test(parsed.protocol) || !IMAGE_HOSTS.has(parsed.hostname)) continue;
        map.set(parsed.toString(), {
          url: parsed.toString(),
          alt: clean(node.attr("alt") ?? "") || undefined,
          width: num(node.attr("width") ?? ""),
          height: num(node.attr("height") ?? "")
        });
      } catch { /* malformed image URLs are skipped */ }
    }
  });
  return [...map.values()].slice(0, 300);
}
function extractTables($: PageDoc): Array<{ headers: string[]; rows: string[][] }> {
  const output: Array<{ headers: string[]; rows: string[][] }> = [];
  $("table").each((_i, table) => {
    const rows = $(table).find("tr").toArray().map(row => $(row).find("th,td").toArray().map(cell => clean($(cell).text())));
    const nonEmpty = rows.filter(row => row.some(Boolean));
    if (!nonEmpty.length) return;
    output.push({ headers: nonEmpty[0] ?? [], rows: nonEmpty.slice(1) });
  });
  return output.slice(0, 100);
}
function extractLabels($: PageDoc): Record<string, string> {
  const labels: Record<string, string> = {};
  $("tr,dl,div.cb-col-100.cb-col,div.cb-col.cb-col-100").each((_i, el) => {
    const node = $(el);
    const children = node.children().toArray().map(child => clean($(child).text())).filter(Boolean);
    if (children.length === 2 && children[0]!.length < 80 && children[1]!.length < 300) {
      labels[children[0]!] = children[1]!;
    }
    if (node.is("tr")) {
      const cells = node.find("th,td").toArray().map(cell => clean($(cell).text())).filter(Boolean);
      if (cells.length === 2 && cells[0]!.length < 80) labels[cells[0]!] = cells[1]!;
    }
  });
  $("dt").each((_i, el) => {
    const key = clean($(el).text());
    const value = clean($(el).next("dd").text());
    if (key && value) labels[key] = value;
  });
  return labels;
}
function extractSections($: PageDoc): Array<{ heading: string; text: string }> {
  const sections: Array<{ heading: string; text: string }> = [];
  $("h1,h2,h3,h4").each((_i, el) => {
    const heading = clean($(el).text());
    if (!heading) return;
    const content: string[] = [];
    let next = $(el).next();
    let count = 0;
    while (next.length && !/^h[1-4]$/i.test(next[0]?.tagName ?? "") && count < 20) {
      const value = clean(next.text());
      if (value) content.push(value);
      next = next.next();
      count += 1;
    }
    sections.push({ heading, text: content.join(" ").slice(0, 6000) });
  });
  return sections.slice(0, 100);
}
function extractStructuredData($: PageDoc): unknown[] {
  const data: unknown[] = [];
  $("script[type='application/ld+json']").each((_i, el) => {
    const content = $(el).contents().text();
    if (!content) return;
    try { data.push(JSON.parse(content)); } catch { /* ignore malformed JSON-LD */ }
  });
  return data;
}
function extractPlayerDetails($: PageDoc): Record<string, unknown> {
  const labels = extractLabels($);
  const text = getMainText($);
  const personal: Record<string, string> = {};
  const known = ["Born", "Birth Place", "Role", "Batting Style", "Bowling Style", "Height"];
  for (const label of known) {
    const value = labeledValue(text, label);
    if (value) personal[label] = value;
  }
  const teams = labeledValue(text, "Teams");
  const summary = $("h2,h3").filter((_i, el) => /summary/i.test($(el).text())).first().next().text();
  return { ...personal, labels, teams: teams ? teams.split(/,\s*/) : [], summary: clean(summary) };
}

function collectRelatedLinks($: PageDoc, baseUrl: string): {
  profiles: LinkRecord[]; teams: LinkRecord[]; series: LinkRecord[]; venues: LinkRecord[];
} {
  const result = { profiles: [] as LinkRecord[], teams: [] as LinkRecord[], series: [] as LinkRecord[], venues: [] as LinkRecord[] };
  for (const link of getLinks($, baseUrl)) {
    if (/^\/profiles\/\d+/.test(link.path)) result.profiles.push(link);
    else if (/^\/cricket-team\//.test(link.path)) result.teams.push(link);
    else if (/^\/cricket-series\/\d+/.test(link.path) && !/\/venues\/\d+/.test(link.path)) result.series.push(link);
    if (/\/venues\/\d+/.test(link.path)) result.venues.push(link);
  }
  return result;
}
function getLinks($: PageDoc, baseUrl: string): LinkRecord[] {
  const map = new Map<string, LinkRecord>();
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const parsed = new URL(href, baseUrl);
      if (parsed.hostname !== "www.cricbuzz.com" || parsed.protocol !== "https:") return;
      const path = parsed.pathname;
      if (path === "/" || path.startsWith("/news/") || path.startsWith("/videos/")) return;
      const url = `${parsed.origin}${path}`;
      if (!map.has(url)) map.set(url, { url, path, text: clean($(el).text()) });
    } catch { /* invalid href */ }
  });
  return [...map.values()];
}
function mergeLinks(target: Map<string, LinkRecord>, links: LinkRecord[]): void {
  for (const link of links) target.set(link.url, link);
}
function addEntity(map: Map<string, CrikoraEntity>, type: EntityType, id: string, url: string, payload: Record<string, unknown>): void {
  map.set(`${type}:${id}`, { entityType: type, sourceId: id, sourceUrl: url, payload, fetchedAt: new Date().toISOString() });
}
function getMainText($: PageDoc): string {
  const candidate = $("main").text() || $("#page-wrapper").text() || $(".container").first().text() || $("body").text();
  return clean(candidate);
}
function labeledValue(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|\\s)${escaped}\\s+([^\\n]{1,250}?)(?=\\s+(?:Born|Birth Place|Role|Batting Style|Bowling Style|Teams|Date|Time|Toss|Venue|Umpires|3rd Umpire|Referee|Capacity|Location|Time Zone|Ends|Home To|Floodlights)\\s|$)`, "i");
  return clean(text.match(regex)?.[1] ?? "");
}
function parseDateTime(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function num(value: string): number {
  const parsed = Number.parseFloat(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
function clean(value: string): string { return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown"; }
function stableHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
function rotate<T>(items: T[], cursor: number, count: number): T[] {
  if (!items.length) return [];
  const limit = Math.min(items.length, count);
  return Array.from({ length: limit }, (_v, index) => items[(cursor + index) % items.length]!);
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Aborted")); }, { once: true });
  });
}

/** Small exported seam for deterministic parser tests. */
export function classifyCricbuzzEntityUrl(url: string): { entityType: EntityType; sourceId: string } | undefined {
  let path: string;
  try { path = new URL(url).pathname; } catch { return undefined; }
  const rule = PATH_RULES.find(item => item.pattern.test(path));
  if (!rule) return undefined;
  const match = rule.pattern.exec(path);
  if (!match) return undefined;
  return {
    entityType: rule.type,
    sourceId: rule.type === "team" ? match[2]! : match[1]!
  };
}

export function parseCricbuzzEntityHtml(html: string, url: string): CrikoraEntity | undefined {
  const identity = classifyCricbuzzEntityUrl(url);
  if (!identity) return undefined;
  return parseEntityPage(load(html), url, identity.entityType);
}
