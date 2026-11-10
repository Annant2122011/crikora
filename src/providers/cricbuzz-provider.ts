import { load, type CheerioAPI } from "cheerio";
import type { CrikoraEntity, EntityType } from "../domain/entities.js";
import type { EventType, Match, MatchEvent, MatchStatus, ProviderSnapshot, SourcePageCapture } from "../domain/types.js";
import { extractCricbuzzFlightData } from "./cricbuzz-rsc.js";
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
  maxContentPagesPerPoll: number;
  timeoutMs: number;
  maxResponseBytes: number;
  userAgent: string;
}
interface DiscoveredMatch { id: string; path: string; bucket: MatchBucket; }
interface PageRecord { url: string; html: string; $: PageDoc; fetchedAt: string; }
interface LinkRecord { url: string; path: string; text: string; }

export interface CrawledPageResult {
  entity?: CrikoraEntity;
  discoveredUrls: string[];
  skipped: boolean;
  sourcePages?: SourcePageCapture[];
}

export interface CricbuzzSitemapDiscoveryResult {
  sitemapUrls: string[];
  pageUrls: string[];
}

const ORIGIN = "https://www.cricbuzz.com";
const INDEXES: Array<{ path: string; bucket: MatchBucket }> = [
  { path: "/cricket-match/live-scores", bucket: "live" },
  { path: "/cricket-match/live-scores/upcoming-matches", bucket: "upcoming" },
  { path: "/cricket-match/live-scores/recent-matches", bucket: "completed" }
];

// Two broad section indexes are sampled every refresh tick. The time-derived
// cursor works across Vercel cold starts without depending on process memory.
const SECTION_INDEXES = [
  "/cricket-news",
  "/cricket-videos",
  "/cricket-videos/categories",
  "/cricket-videos/playlists",
  "/cricket-photo-gallery",
  "/cricket-team",
  "/profiles",
  "/cricket-schedule/series/all",
  "/cricket-schedule/upcoming-series/international",
  "/cricket-stats/icc-rankings/men/batting",
  "/cricket-stats/icc-rankings/women/batting",
  "/cricket-stats/points-table/test/icc-world-test-championship",
  "/cricket-series/auctions",
  "/cricket-scorecard-archives"
];

const PATH_RULES: Array<{ type: EntityType; pattern: RegExp; kind?: string }> = [
  { type: "match", pattern: /^\/live-cricket-scores\/(\d+)\/[^/]+\/?$/ },
  { type: "metadata", kind: "match-facts", pattern: /^\/cricket-match-facts\/(\d+)\/[^/]+\/?$/ },
  { type: "metadata", kind: "match-squads", pattern: /^\/cricket-match-squads\/(\d+)\/[^/]+\/?$/ },
  { type: "metadata", kind: "match-scorecard", pattern: /^\/live-cricket-scorecard\/(\d+)\/[^/]+\/?$/ },
  { type: "player", pattern: /^\/profiles\/(\d+)\/[^/]+\/?$/ },
  { type: "metadata", kind: "player-stats", pattern: /^\/profiles\/(\d+)\/[^/]+\/(?:all-matches|batting|bowling|stats)(?:\/.*)?$/ },
  { type: "metadata", kind: "player-directory", pattern: /^\/profiles\/?$/ },
  { type: "team", pattern: /^\/cricket-team\/([^/]+)\/(\d+)\/?$/ },
  { type: "metadata", kind: "team-subpage", pattern: /^\/cricket-team\/([^/]+)\/(\d+)\/(.+)$/ },
  { type: "metadata", kind: "team-directory", pattern: /^\/cricket-team\/?$/ },
  { type: "venue", pattern: /^\/cricket-series\/\d+\/[^/]+\/venues\/(\d+)(?:\/[^/]+)?\/?$/ },
  { type: "series", pattern: /^\/cricket-series\/(\d+)\/[^/]+\/?$/ },
  { type: "metadata", kind: "series-subpage", pattern: /^\/cricket-series\/(\d+)\/[^/]+\/(.+)$/ },
  { type: "metadata", kind: "series-auction", pattern: /^\/cricket-series\/([^/]+)\/auction(?:\/(.+))?\/?$/ },
  { type: "metadata", kind: "series-catalog", pattern: /^\/cricket-series\/(?!\d+\/)(.+)$/ },
  { type: "metadata", kind: "news", pattern: /^\/cricket-news\/(\d+)\/[^/]+\/?$/ },
  { type: "metadata", kind: "news-index", pattern: /^\/cricket-news\/?$/ },
  { type: "metadata", kind: "news-category", pattern: /^\/cricket-news\/(?!\d+\/)(.+)\/?$/ },
  { type: "metadata", kind: "video", pattern: /^\/cricket-videos\/(\d+)\/[^/]+\/?$/ },
  { type: "metadata", kind: "video-collection", pattern: /^\/cricket-videos\/collection\/(\d+)\/(.+)\/?$/ },
  { type: "metadata", kind: "video-playlists", pattern: /^\/cricket-videos\/playlists\/?$/ },
  { type: "metadata", kind: "video-categories", pattern: /^\/cricket-videos\/categories\/?$/ },
  { type: "metadata", kind: "video-index", pattern: /^\/cricket-videos\/?$/ },
  { type: "metadata", kind: "gallery", pattern: /^\/cricket-gallery\/(\d+)\/[^/]+\/?$/ },
  { type: "metadata", kind: "gallery-index", pattern: /^\/cricket-photo-gallery\/?$/ },
  { type: "metadata", kind: "ranking-or-statistics", pattern: /^\/cricket-stats(?:\/(.+))?\/?$/ },
  { type: "metadata", kind: "schedule", pattern: /^\/cricket-schedule(?:\/(.*))?\/?$/ },
  { type: "metadata", kind: "scorecard-archives", pattern: /^\/cricket-scorecard-archives(?:\/(.*))?\/?$/ },
  { type: "metadata", kind: "commentary", pattern: /^\/live-cricket-full-commentary\/(\d+)\/(.+)$/ },
  { type: "metadata", kind: "live-stream-page", pattern: /^\/live-cricket-stream\/(\d+)\/(.+)$/ },
  { type: "metadata", kind: "player-match-performance", pattern: /^\/player-match-performance\/match\/(\d+)\/player\/(\d+)\/(batting|bowling)\/?$/ },
  { type: "metadata", kind: "match-highlights", pattern: /^\/cricket-match-highlights\/(\d+)\/(.+)$/ },
  { type: "metadata", kind: "live-graphs", pattern: /^\/live-cricket-graphs\/(\d+)\/(.+)$/ },
  { type: "metadata", kind: "wicket-zone", pattern: /^\/special-content\/wicket-zone\/(\d+)\/(.+)$/ },
  { type: "metadata", kind: "match-forecast", pattern: /^\/cricket-match-forecast\/(\d+)\/(.+)$/ },
  { type: "metadata", kind: "player-match-highlights", pattern: /^\/player-match-highlights\/(\d+)\/(.+)$/ },
  { type: "metadata", kind: "over-by-over", pattern: /^\/live-cricket-over-by-over\/(\d+)\/(.+)$/ }
];

export class CricbuzzProvider implements CricketProvider {
  readonly id = "cricbuzz";
  private lastRequestAt = 0;
  private matchCursor = 0;
  // Retain discovered URLs that do not fit the current related-page budget.
  private readonly pendingRelatedLinks = new Map<EntityType, Map<string, LinkRecord>>();

  constructor(private readonly options: Options) {
    if (!Number.isInteger(options.minRequestIntervalMs) || options.minRequestIntervalMs < 0) {
      throw new Error("Cricbuzz request interval must be a non-negative integer.");
    }
    if (options.maxMatchesPerPoll < 1 || options.maxMatchesPerPoll > 50) throw new Error("Invalid maxMatchesPerPoll.");
    if (!Number.isInteger(options.maxContentPagesPerPoll) || options.maxContentPagesPerPoll < 0 || options.maxContentPagesPerPoll > 100) {
      throw new Error("Invalid maxContentPagesPerPoll.");
    }
  }

  async fetchSnapshot(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const discovered = new Map<string, DiscoveredMatch>();
    const indexRecords = new Map<string, Match>();
    const capturedPages = new Map<string, PageRecord>();
    for (const index of INDEXES) {
      const page = await this.tryFetchPage(new URL(index.path, ORIGIN), `index:${index.bucket}`, signal);
      if (!page) continue;
      capturedPages.set(page.url, page);
      for (const link of getLinks(page.$, page.url)) {
        const match = link.path.match(/^\/live-cricket-scores\/(\d+)(?:\/|$)/);
        if (match?.[1] && !discovered.has(match[1])) {
          const item: DiscoveredMatch = { id: match[1], path: link.path, bucket: index.bucket };
          const stub = parseMatchIndexStub(item, page, link);
          discovered.set(match[1], item);
          indexRecords.set(match[1], stub);
        }
      }
    }

    const sectionTick = Math.floor(Date.now() / 10_000);
    const sectionStart = (sectionTick * 2) % SECTION_INDEXES.length;
    const sectionPaths = rotate(SECTION_INDEXES, sectionStart, 2);
    const sectionPages: PageRecord[] = [];
    for (const path of sectionPaths) {
      if (signal?.aborted) throw signal.reason ?? new Error("Cricbuzz collection aborted.");
      const page = await this.tryFetchPage(new URL(path, ORIGIN), "section-index", signal);
      if (page) {
        sectionPages.push(page);
        capturedPages.set(page.url, page);
      }
    }

    const allMatches = [...discovered.values()];
    const selected = rotate(allMatches, this.matchCursor, this.options.maxMatchesPerPoll);
    if (allMatches.length) this.matchCursor = (this.matchCursor + selected.length) % allMatches.length;

    const matches: Match[] = [...indexRecords.values()];
    const events: MatchEvent[] = [];
    const entities = new Map<string, CrikoraEntity>();
    for (const [sourceId, stub] of indexRecords) {
      addEntity(
        entities,
        "match",
        sourceId,
        stub.sourceUrl ?? `https://www.cricbuzz.com/live-cricket-scores/${sourceId}`,
        stub as unknown as Record<string, unknown>
      );
    }
    const profileLinks = new Map<string, LinkRecord>();
    const teamLinks = new Map<string, LinkRecord>();
    const seriesLinks = new Map<string, LinkRecord>();
    const venueLinks = new Map<string, LinkRecord>();
    const contentLinks = new Map<string, LinkRecord>();

    for (const discoveredMatch of selected) {
      if (signal?.aborted) throw signal.reason ?? new Error("Cricbuzz collection aborted.");
      const base = await this.tryFetchPage(new URL(discoveredMatch.path, ORIGIN), "match", signal);
      if (!base) continue;
      const navigation = collectMatchNavigation(base.$, base.url, discoveredMatch.id);
      const info = navigation.info
        ? await this.tryFetchPage(new URL(navigation.info, ORIGIN), "match-facts", signal)
        : undefined;
      const scorecard = navigation.scorecard
        ? await this.tryFetchPage(new URL(navigation.scorecard, ORIGIN), "scorecard", signal)
        : undefined;
      const squads = navigation.squads
        ? await this.tryFetchPage(new URL(navigation.squads, ORIGIN), "squads", signal)
        : undefined;
      const commentary = navigation.commentary
        ? await this.tryFetchPage(new URL(navigation.commentary, ORIGIN), "commentary", signal)
        : undefined;

      const match = parseMatch(discoveredMatch, base, info, scorecard, squads);
      const matchEvents = commentary ? parseEvents(commentary.$, match) : parseEvents(base.$, match);
      match.events = matchEvents;
      const existingIndex = matches.findIndex(existing => existing.sourceMatchId === match.sourceMatchId);
      if (existingIndex >= 0) matches[existingIndex] = match;
      else matches.push(match);
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
        capturedPages.set(page.url, page);
        const related = collectRelatedLinks(page.$, page.url);
        mergeLinks(profileLinks, related.profiles);
        mergeLinks(teamLinks, related.teams);
        mergeLinks(seriesLinks, related.series);
        mergeLinks(venueLinks, related.venues);
        mergeLinks(contentLinks, related.content);
        const generic = parseEntityPage(page.$, page.url);
        if (generic) addEntity(entities, generic.entityType, generic.sourceId, generic.sourceUrl, generic.payload);
      }
    }

    for (const page of sectionPages) {
      const related = collectRelatedLinks(page.$, page.url);
      mergeLinks(profileLinks, related.profiles);
      mergeLinks(teamLinks, related.teams);
      mergeLinks(seriesLinks, related.series);
      mergeLinks(venueLinks, related.venues);
      mergeLinks(contentLinks, related.content);
      const generic = parseEntityPage(page.$, page.url);
      if (generic) addEntity(entities, generic.entityType, generic.sourceId, generic.sourceUrl, generic.payload);
    }

    await this.fetchRelatedEntities(profileLinks, this.options.maxProfilesPerPoll, "player", entities, capturedPages, signal);
    await this.fetchRelatedEntities(teamLinks, this.options.maxTeamsPerPoll, "team", entities, capturedPages, signal);
    await this.fetchRelatedEntities(seriesLinks, this.options.maxSeriesPerPoll, "series", entities, capturedPages, signal);
    await this.fetchRelatedEntities(venueLinks, this.options.maxVenuesPerPoll, "venue", entities, capturedPages, signal);
    await this.fetchRelatedEntities(contentLinks, this.options.maxContentPagesPerPoll, "metadata", entities, capturedPages, signal);

    const fetchedAt = new Date().toISOString();
    return { matches, events, entities: [...entities.values()], fetchedAt, sourcePages: [...capturedPages.values()].map(toSourcePageCapture) };
  }

  isAllowedCrawlUrl(value: string): boolean {
    return isAllowedCricbuzzPageUrl(value);
  }

  getPendingRelatedUrls(): string[] {
    return [...this.pendingRelatedLinks.values()].flatMap(queue => [...queue.keys()]);
  }

  /**
   * Read Cricbuzz's public sitemap documents and return only allowed sitemap-listed pages.
   * Sitemap XML is discovery metadata; it is never stored as a cricket entity.
   */
  async discoverSitemapUrls(signal?: AbortSignal): Promise<CricbuzzSitemapDiscoveryResult> {
    const pending = [new URL("/sitemap.xml", ORIGIN)];
    const visitedSitemaps = new Set<string>();
    const sitemapUrls = new Set<string>();
    const pageUrls = new Set<string>();

    while (pending.length) {
      if (signal?.aborted) throw signal.reason ?? new Error("Cricbuzz sitemap discovery aborted.");
      if (visitedSitemaps.size >= 50) {
        throw new Error("Cricbuzz sitemap discovery exceeded the 50-document safety limit.");
      }
      const sitemapUrl = pending.shift()!;
      const canonicalSitemapUrl = sitemapUrl.toString();
      if (visitedSitemaps.has(canonicalSitemapUrl)) continue;
      if (!isAllowedCricbuzzSitemapUrl(canonicalSitemapUrl)) {
        throw new Error("Refusing to fetch a sitemap outside the Cricbuzz sitemap allowlist.");
      }
      visitedSitemaps.add(canonicalSitemapUrl);

      let xml: string;
      try {
        xml = await this.fetchSitemapDocument(sitemapUrl, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const status = readSourceStatus(error);
        if (status === undefined || status === 401 || status === 403 ||
            (status !== undefined && status >= 300 && status < 400) ||
            (status !== undefined && status >= 400 && status < 500 && status !== 429)) {
          console.warn("Crikora skipped an unavailable sitemap document and will continue with other cricket sitemaps or the saved inventory", {
            url: canonicalSitemapUrl,
            status,
            message: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
        throw error;
      }

      sitemapUrls.add(canonicalSitemapUrl);
      const discovered = parseCricbuzzSitemapXml(xml, canonicalSitemapUrl);
      for (const child of discovered.sitemapUrls) {
        if (!visitedSitemaps.has(child)) pending.push(new URL(child));
      }
      for (const pageUrl of discovered.pageUrls) pageUrls.add(pageUrl);
    }

    if (!pageUrls.size) {
      console.warn("Crikora sitemap discovery found no accessible cricket pages; the caller can fall back to the saved cricket-only inventory.");
    }
    return { sitemapUrls: [...sitemapUrls], pageUrls: [...pageUrls] };
  }

  /**
   * Fetch and normalize one page for the durable sitemap crawl. The caller
   * persists the payload through the normal ten-minute entity cache.
   */
  async fetchCrawlPage(value: string, signal?: AbortSignal): Promise<CrawledPageResult> {
    const url = new URL(value);
    assertAllowedPageUrl(url);
    const page = await this.tryFetchPage(url, "durable-full-crawl", signal);
    if (!page) return { discoveredUrls: [], skipped: true };

    const identity = classifyCricbuzzEntityUrl(page.url);
    let entity: CrikoraEntity | undefined;
    let pages: PageRecord[] = [page];
    if (identity?.entityType === "match") {
      const body = getMainText(page.$);
      const bucket: MatchBucket = /\b(?:won by|match abandoned|match drawn|match tied|no result)\b/i.test(body)
        ? "completed"
        : /\b(?:upcoming|scheduled|starts at|will start)\b/i.test(body)
          ? "upcoming"
          : "live";
      const navigation = collectMatchNavigation(page.$, page.url, identity.sourceId);
      const fallback = matchCompanionUrls(page.url, identity.sourceId);
      // Prefer links published by the page; only synthesize same-ID companion paths
      // when the page omits a tab link. Requests remain sequential and same-host.
      const infoUrl = navigation.info ?? fallback.info;
      const scorecardUrl = navigation.scorecard ?? fallback.scorecard;
      const squadsUrl = navigation.squads ?? fallback.squads;
      const commentaryUrl = navigation.commentary ?? fallback.commentary;
      const info = infoUrl ? await this.tryFetchPage(new URL(infoUrl), "durable:match-facts", signal) : undefined;
      const scorecard = scorecardUrl ? await this.tryFetchPage(new URL(scorecardUrl), "durable:scorecard", signal) : undefined;
      const squadsPage = squadsUrl ? await this.tryFetchPage(new URL(squadsUrl), "durable:squads", signal) : undefined;
      const commentary = commentaryUrl ? await this.tryFetchPage(new URL(commentaryUrl), "durable:commentary", signal) : undefined;
      pages = [page, info, scorecard, squadsPage, commentary].filter((item): item is PageRecord => Boolean(item));
      const match = parseMatch({ id: identity.sourceId, path: url.pathname, bucket }, page, info, scorecard, squadsPage);
      match.infoUrl = info?.url;
      match.scorecardUrl = scorecard?.url;
      match.squadsUrl = squadsPage?.url;
      match.commentaryUrl = commentary?.url;
      entity = {
        entityType: "match",
        sourceId: identity.sourceId,
        sourceUrl: page.url,
        payload: {
          ...match,
          pageKind: "match-overview",
          matchFacts: info ? extractPageData(info.$, info.url) : null,
          scorecardPage: scorecard ? extractPageData(scorecard.$, scorecard.url) : null,
          squadPage: squadsPage ? extractPageData(squadsPage.$, squadsPage.url) : null,
          commentaryPage: commentary ? extractPageData(commentary.$, commentary.url) : null,
          sourcePages: pages.map(item => item.url)
        },
        fetchedAt: new Date().toISOString()
      };
    } else if (identity) {
      entity = parseEntityPage(page.$, page.url, identity.entityType);
    }

    if (!entity) {
      const path = new URL(page.url).pathname.replace(/\/+$/, "") || "/";
      entity = {
        entityType: "metadata",
        sourceId: "page:" + stableHash(path),
        sourceUrl: page.url,
        payload: { ...extractPageData(page.$, page.url), entityType: "metadata", pageKind: "unclassified-public-page" },
        fetchedAt: new Date().toISOString()
      };
    }

    const discoveredUrls = [...new Set([
      ...pages.slice(1).map(item => item.url),
      ...pages.flatMap(item => getLinks(item.$, item.url).map(link => link.url))
    ])]
      .filter(linkUrl => isAllowedCricbuzzPageUrl(linkUrl))
      .slice(0, 250);
    return { entity, discoveredUrls, skipped: false, sourcePages: pages.map(toSourcePageCapture) };
  }

  private async fetchRelatedEntities(
    links: Map<string, LinkRecord>,
    limit: number,
    expectedType: EntityType,
    entities: Map<string, CrikoraEntity>,
    capturedPages: Map<string, PageRecord>,
    signal?: AbortSignal
  ): Promise<void> {
    if (!limit) return;
    let pending = this.pendingRelatedLinks.get(expectedType);
    if (!pending) {
      pending = new Map<string, LinkRecord>();
      this.pendingRelatedLinks.set(expectedType, pending);
    }
    for (const link of links.values()) if (!pending.has(link.url)) pending.set(link.url, link);
    // Bound process memory while keeping FIFO order for the oldest pending URLs.
    while (pending.size > 2_000) {
      const newest = [...pending.keys()].at(-1);
      if (!newest) break;
      pending.delete(newest);
    }
    const candidates = [...pending.values()].slice(0, limit);
    for (const link of candidates) {
      if (signal?.aborted) throw signal.reason ?? new Error("Cricbuzz collection aborted.");
      const page = await this.tryFetchPage(new URL(link.url), `related:${expectedType}`, signal);
      if (page) {
        capturedPages.set(page.url, page);
        const parsed = parseEntityPage(page.$, page.url, expectedType);
        if (parsed) addEntity(entities, parsed.entityType, parsed.sourceId, parsed.sourceUrl, parsed.payload);
      }
      // Ordinary page failures are isolated; source denials still throw above.
      pending.delete(link.url);
    }
  }

  /**
   * Keep a cycle useful when an individual content page disappears or is
   * temporarily unavailable. Explicit source denials, throttling, aborts and
   * upstream 5xx still stop the cycle so the worker can pause/back off.
   */
  private async tryFetchPage(url: URL, context: string, signal?: AbortSignal): Promise<PageRecord | undefined> {
    try {
      return await this.fetchPage(url, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const status = readSourceStatus(error);
      if (status !== undefined && status >= 300 && status < 400) {
        console.warn("Crikora skipped a redirected Cricbuzz page without following the redirect", {
          context,
          url: url.toString(),
          status
        });
        return undefined;
      }
      if (status === 401 || status === 403 ||
          (status !== undefined && status >= 400 && status < 500 && status !== 429)) {
        console.warn("Crikora skipped one challenged or unavailable cricket page; the rest of the crawl will continue", {
          context,
          url: url.toString(),
          status,
          message: error instanceof Error ? error.message : String(error)
        });
        return undefined;
      }
      if (status === 429 || (status !== undefined && status >= 500)) {
        throw error;
      }
      console.warn("Crikora skipped an unavailable Cricbuzz page", {
        context,
        url: url.toString(),
        status: status ?? null,
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  private async fetchSitemapDocument(url: URL, signal?: AbortSignal): Promise<string> {
    if (!isAllowedCricbuzzSitemapUrl(url.toString())) {
      throw new Error("Refusing to request a non-Cricbuzz sitemap URL.");
    }
    const waitMs = Math.max(0, this.options.minRequestIntervalMs - (Date.now() - this.lastRequestAt));
    if (waitMs) await delay(waitMs, signal);
    this.lastRequestAt = Date.now();

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, {
      signal: combined,
      headers: {
        "user-agent": this.options.userAgent,
        accept: "application/xml,text/xml;q=0.9,text/plain;q=0.5"
      },
      redirect: "manual"
    });
    if ([401, 403, 429].includes(response.status)) {
      throw createSourceHttpError(
        "Cricbuzz denied or throttled sitemap " + url.pathname + " (HTTP " + response.status + "). Stop and respect the source response.",
        response.status,
        response.headers.get("retry-after")
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw createSourceHttpError(
        "Cricbuzz redirected sitemap " + url.pathname + " (HTTP " + response.status + "); automatic redirect following is disabled.",
        response.status
      );
    }
    if (!response.ok) {
      throw createSourceHttpError(
        "Cricbuzz returned HTTP " + response.status + " for sitemap " + url.pathname,
        response.status,
        response.headers.get("retry-after")
      );
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !contentType.includes("xml") && !contentType.includes("text/plain")) {
      throw new Error("Expected XML from Cricbuzz sitemap at " + url.pathname + ".");
    }
    const body = await readLimitedBody(response, this.options.maxResponseBytes);
    const xml = new TextDecoder().decode(body);
    if (/captcha|robot check|access denied|unusual traffic/i.test(xml.slice(0, 100_000))) {
      throw createSourceHttpError("Cricbuzz presented an access challenge while reading its sitemap; discovery stopped.", 403);
    }
    if (!/<(?:\?xml\b|urlset\b|sitemapindex\b)/i.test(xml)) {
      throw new Error("Cricbuzz sitemap " + url.pathname + " did not contain a recognized XML sitemap document.");
    }
    return xml;
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
      throw createSourceHttpError(
        `Cricbuzz denied or throttled ${url.pathname} (HTTP ${response.status}). Stop and respect the source response.`,
        response.status,
        response.headers.get("retry-after")
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw createSourceHttpError(
        `Cricbuzz redirected ${url.pathname} (HTTP ${response.status}); automatic redirect following is disabled.`,
        response.status
      );
    }
    if (!response.ok) {
      throw createSourceHttpError(
        `Cricbuzz returned HTTP ${response.status} for ${url.pathname}`,
        response.status,
        response.headers.get("retry-after")
      );
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error(`Expected HTML from Cricbuzz at ${url.pathname}.`);
    }
    const body = await readLimitedBody(response, this.options.maxResponseBytes);
    const html = new TextDecoder().decode(body);
    if (/captcha|robot check|access denied|unusual traffic/i.test(html.slice(0, 100_000))) {
      throw createSourceHttpError("Cricbuzz presented an access challenge; the collector stopped without bypassing it.", 403);
    }
    return { url: url.toString(), html, $: load(html), fetchedAt: new Date().toISOString() };
  }
}


function toSourcePageCapture(page: PageRecord): SourcePageCapture {
  const parsed = new URL(page.url);
  const identity = classifyCricbuzzEntityUrl(page.url);
  return {
    url: page.url,
    html: page.html,
    contentType: "text/html; charset=utf-8",
    fetchedAt: page.fetchedAt,
    pageKind: parsed.pathname.split("/").filter(Boolean)[0] ?? "root",
    ...(identity ? { entityType: identity.entityType, sourceId: identity.sourceId } : {})
  };
}

function readSourceStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("sourceStatus" in error)) return undefined;
  const value = Number((error as { sourceStatus?: unknown }).sourceStatus);
  return Number.isInteger(value) ? value : undefined;
}

function createSourceHttpError(message: string, status: number, retryAfter?: string | null): Error & { sourceStatus: number; retryAfterMs?: number } {
  const error = new Error(message) as Error & { sourceStatus: number; retryAfterMs?: number };
  error.sourceStatus = status;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const dateMs = Date.parse(retryAfter);
    const wait = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Number.isFinite(dateMs)
        ? Math.max(0, dateMs - Date.now())
        : undefined;
    if (wait !== undefined) error.retryAfterMs = wait;
  }
  return error;
}

export function isAllowedCricbuzzSitemapUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.cricbuzz.com" &&
      !url.username && !url.password && /^\/(?:sitemap\.xml|sitemap\/[a-z0-9-]+\.xml)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function decodeXmlCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => decodeXmlCodePoint(code, 16))
    .replace(/&#([0-9]+);/g, (_match, code: string) => decodeXmlCodePoint(code, 10))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Separate allowed Cricbuzz sitemap documents from allowed page URLs. */
export function parseCricbuzzSitemapXml(xml: string, sitemapUrl = "https://www.cricbuzz.com/sitemap.xml"): CricbuzzSitemapDiscoveryResult {
  const sitemapUrls = new Set<string>();
  const pageUrls = new Set<string>();
  for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const raw = decodeXmlText(match[1] ?? "").trim();
    if (!raw) continue;
    try {
      const url = new URL(raw, sitemapUrl);
      if (url.protocol !== "https:" || url.hostname !== "www.cricbuzz.com" || url.username || url.password) continue;
      url.hash = "";
      const canonical = url.toString();
      if (isAllowedCricbuzzSitemapUrl(canonical)) sitemapUrls.add(canonical);
      else if (isAllowedCricbuzzPageUrl(canonical)) pageUrls.add(canonical);
    } catch {
      // Invalid or non-HTTP loc entries are ignored, never fetched.
    }
  }
  return { sitemapUrls: [...sitemapUrls], pageUrls: [...pageUrls] };
}

function assertAllowedPageUrl(url: URL): void {
  if (url.protocol !== "https:" || url.hostname !== "www.cricbuzz.com" || url.username || url.password) {
    throw new Error("Refusing to request a non-Cricbuzz or non-HTTPS page.");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const isKnownCricketIndex = INDEXES.some(index => index.path === path) || SECTION_INDEXES.includes(path);
  const isKnownCricketDataRoute = Boolean(classifyCricbuzzEntityUrl(url.toString()));
  if (!isKnownCricketIndex && !isKnownCricketDataRoute) {
    throw new Error("Page path is outside Crikora's cricket-data scope: " + url.pathname);
  }
}

export function isAllowedCricbuzzPageUrl(value: string): boolean {
  try {
    assertAllowedPageUrl(new URL(value));
    return true;
  } catch {
    return false;
  }
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

function matchCompanionUrls(pageUrl: string, matchId: string): {
  info?: string; scorecard?: string; squads?: string; commentary?: string;
} {
  const parsed = new URL(pageUrl);
  const match = parsed.pathname.match(/^\/live-cricket-scores\/(\d+)\/([^/]+)\/?$/);
  if (!match || match[1] !== matchId || !match[2]) return {};
  const slug = match[2];
  return {
    info: `${ORIGIN}/cricket-match-facts/${matchId}/${slug}`,
    scorecard: `${ORIGIN}/live-cricket-scorecard/${matchId}/${slug}`,
    squads: `${ORIGIN}/cricket-match-squads/${matchId}/${slug}`,
    commentary: `${ORIGIN}/live-cricket-full-commentary/${matchId}/${slug}`
  };
}

export function classifyMatchFormat(value: string): string {
  const text = value.toLowerCase();
  if (/\bthe hundred\b/.test(text)) return "The Hundred";
  if (/\b(?:t10|ten10)\b/.test(text)) return "T10";
  if (/\b(?:hong kong )?sixes\b|\bsix[- ]a[- ]side\b|\b6ixty\b/.test(text)) return "Sixes";
  if (/\btest\b/.test(text)) return "Test";
  if (/\bodi\b/.test(text)) return "ODI";
  if (/\bt20\b/.test(text)) return "T20";
  return "Unknown";
}
function parseMatchIndexStub(item: DiscoveredMatch, page: PageRecord, link: LinkRecord): Match {
  const anchor = page.$("a[href]").filter((_i, element) => {
    const href = page.$(element).attr("href");
    if (!href) return false;
    try { return new URL(href, page.url).pathname === link.path; } catch { return false; }
  }).first();
  const context = clean(anchor.parent().parent().parent().text() || anchor.parent().parent().text() || link.text);
  const titleCandidate = context.match(/([^|]{2,100}?\s+vs\s+[^|]{2,100}?)(?:\s{2,}|$)/i)?.[1];
  const title = clean(titleCandidate || link.text || context.slice(0, 180));
  const teams = title.match(/^(.+?)\s+vs\s+(.+?)(?:,|$)/i);
  const now = new Date().toISOString();
  const format = classifyMatchFormat(context);
  const sourceUrl = link.url;
  return {
    id: `cricbuzz:${item.id}`,
    source: "cricbuzz",
    sourceMatchId: item.id,
    competition: "Cricket",
    homeTeam: clean(teams?.[1] ?? "") || "Unknown",
    awayTeam: clean(teams?.[2] ?? "") || "Unknown",
    status: item.bucket,
    format,
    startTime: "",
    innings: [],
    updatedAt: now,
    sourceUrl,
    description: title,
    stats: { indexCardText: context.slice(0, 2500), discoveredFrom: item.bucket }
  };
}

function parseMatch(discovered: DiscoveredMatch, base: PageRecord, info?: PageRecord, scorecard?: PageRecord, squadsPage?: PageRecord): Match {
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
  const format = classifyMatchFormat(title);
  const images = extractImages($);
  return {
    id: `cricbuzz:${discovered.id}`, source: "cricbuzz", sourceMatchId: discovered.id,
    competition, homeTeam, awayTeam, status, format, startTime: parseDateTime(dateTimeText) ?? "",
    venue: venueLink?.text || venueText || undefined, description: title, innings, updatedAt: now,
    sourceUrl: base.url, infoUrl: info?.url, scorecardUrl: scorecard?.url,
    squadsUrl: getLinks(base.$, base.url).find(l => l.path.startsWith("/cricket-match-squads/"))?.url,
    commentaryUrl: getLinks(base.$, base.url).find(l => l.path.startsWith("/live-cricket-full-commentary/"))?.url,
    toss: toss || undefined, result,
    stats: { liveSummary: body.slice(0, 5000), scorecardText: scoreText.slice(0, 12000), infoText: infoText.slice(0, 12000), seriesUrl: seriesLink?.url, dateTimeText, seriesName: competition },
    images,
    officials: info ? extractLabels(info.$) : undefined,
    squads: squadsPage ? extractSquadData(squadsPage.$, squadsPage.url) : undefined,
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
  const identity = classifyCricbuzzEntityUrl(url);
  const match = rule?.pattern.exec(path);
  const sourceId = identity?.sourceId ??
    (match?.[2] && entityType === "team" ? match[2] : match?.[1] ?? `${entityType}:${stableHash(path)}`);
  const data = extractPageData($, url);
  const contentKind = rule?.kind ?? entityType;
  const payload: Record<string, unknown> = {
    ...data,
    entityType,
    pageKind: contentKind,
    name: data.title ?? data.heading ?? new URL(url).pathname.split("/").filter(Boolean).at(-1),
    profile: entityType === "player" ? extractPlayerDetails($) : undefined,
    statistics: data.tables,
    associations: getLinks($, url).filter(link => /profiles|cricket-team|cricket-series/.test(link.path))
  };
  return { entityType, sourceId, sourceUrl: url, payload, fetchedAt: new Date().toISOString() };
}

function extractControls($: PageDoc): Array<Record<string, string>> {
  const controls: Array<Record<string, string>> = [];
  $("button,[role='tab'],[role='button'],[data-tab]").each((_i, el) => {
    const node = $(el);
    const entry: Record<string, string> = {
      tag: (el as { tagName?: string }).tagName ?? "control",
      label: clean(node.text())
    };
    for (const name of ["id", "class", "role", "type", "aria-label", "aria-controls", "aria-selected", "data-tab", "data-target", "data-url", "href", "title"]) {
      const value = node.attr(name);
      if (value) entry[name] = clean(value);
    }
    if (entry.label || Object.keys(entry).length > 2) controls.push(entry);
  });
  return controls.slice(0, 100);
}

function extractPageData($: PageDoc, url: string): Record<string, unknown> {
  const title = clean($("h1").first().text() || $("title").text());
  const mainText = getMainText($);
  const scripts: string[] = [];
  $("script").each((_i, script) => {
    const content = $(script).html() ?? "";
    if (content.includes("self.__next_f.push")) scripts.push(content);
  });
  const serverComponents = extractCricbuzzFlightData(scripts);
  return {
    title,
    canonicalUrl: $("link[rel='canonical']").attr("href") || url,
    meta: extractMeta($),
    images: extractImages($),
    media: extractMediaReferences($, url),
    links: getLinks($, url).slice(0, 500),
    labels: extractLabels($),
    tables: extractTables($),
    sections: extractSections($),
    structuredData: extractStructuredData($),
    serverComponents,
    controls: extractControls($),
    text: mainText.slice(0, 30000)
  };
}

function extractMediaReferences($: PageDoc, baseUrl: string): Array<Record<string, string>> {
  const items = new Map<string, Record<string, string>>();
  const add = (value: string | undefined, tag: string, kind: string, title?: string, poster?: string) => {
    if (!value || value.startsWith("data:")) return;
    try {
      const parsed = new URL(value, baseUrl);
      if (parsed.protocol !== "https:") return;
      const key = parsed.toString();
      items.set(key, {
        url: key,
        tag,
        kind,
        ...(title ? { title: clean(title) } : {}),
        ...(poster ? { poster } : {})
      });
    } catch { /* malformed media URL */ }
  };
  $("video[src],audio[src],source[src],iframe[src]").each((_i, element) => {
    const node = $(element);
    const tag = (element as { tagName?: string }).tagName?.toLowerCase() ?? "media";
    add(
      node.attr("src") ?? node.attr("data-src"),
      tag,
      node.attr("type") ?? tag,
      node.attr("title") ?? node.attr("aria-label"),
      node.attr("poster")
    );
  });
  $("video[poster]").each((_i, element) => {
    const node = $(element);
    const poster = node.attr("poster");
    if (poster) add(poster, "video", "poster", node.attr("title"));
  });
  $("meta[property='og:video'],meta[property='og:video:url'],meta[name='twitter:player']").each((_i, element) => {
    const node = $(element);
    add(node.attr("content"), "meta", "video", $("h1").first().text());
  });
  return [...items.values()].slice(0, 100);
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
  const add = (value: string | undefined, alt?: string, width?: string, height?: string) => {
    if (!value || /^data:/i.test(value)) return;
    try {
      const parsed = new URL(value, ORIGIN);
      const isCricbuzzHost = parsed.hostname === "cricbuzz.com" || parsed.hostname.endsWith(".cricbuzz.com");
      if (parsed.protocol !== "https:" || !isCricbuzzHost) return;
      map.set(parsed.toString(), {
        url: parsed.toString(),
        alt: clean(alt ?? "") || undefined,
        width: width ? num(width) : undefined,
        height: height ? num(height) : undefined
      });
    } catch { /* malformed or relative-only values that cannot be resolved are skipped */ }
  };

  $("img").each((_i, el) => {
    const node = $(el);
    const alt = node.attr("alt");
    add(node.attr("data-src"), alt, node.attr("width"), node.attr("height"));
    add(node.attr("data-original"), alt, node.attr("width"), node.attr("height"));
    add(node.attr("data-lazy-src"), alt, node.attr("width"), node.attr("height"));
    add(node.attr("src"), alt, node.attr("width"), node.attr("height"));
    for (const candidate of (node.attr("data-srcset") ?? "").split(",")) {
      const [src, size] = candidate.trim().split(/\s+/);
      add(src, alt, size?.endsWith("w") ? size.slice(0, -1) : undefined);
    }
    for (const candidate of (node.attr("srcset") ?? "").split(",")) {
      const [src, size] = candidate.trim().split(/\s+/);
      add(src, alt, size?.endsWith("w") ? size.slice(0, -1) : undefined);
    }
  });
  $("source[srcset]").each((_i, el) => {
    for (const candidate of ($(el).attr("srcset") ?? "").split(",")) {
      const [src] = candidate.trim().split(/\s+/);
      add(src);
    }
  });
  $("meta[property='og:image'],meta[name='twitter:image'],meta[property='twitter:image']").each((_i, el) => {
    add($(el).attr("content"), $("h1").first().text());
  });
  $("video[poster]").each((_i, el) => {
    const node = $(el);
    add(node.attr("poster"), node.attr("aria-label") ?? node.attr("title"));
  });
  $("link[rel='image_src']").each((_i, el) => add($(el).attr("href")));
  $("[style*='background-image']").each((_i, el) => {
    const style = $(el).attr("style") ?? "";
    for (const match of style.matchAll(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/gi)) {
      add(match[2], $(el).attr("aria-label") ?? $(el).attr("title"));
    }
  });
  return [...map.values()].slice(0, 500);
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
function extractSquadData($: PageDoc, baseUrl: string): Record<string, unknown> {
  const players = new Map<string, { sourceId: string; name: string; url: string; images: ReturnType<typeof extractImages> }>();
  for (const link of getLinks($, baseUrl)) {
    const profileId = link.path.match(/^\/profiles\/(\d+)(?:\/|$)/)?.[1];
    if (!profileId) continue;
    const parent = $(`a[href="${link.path}"]`).first();
    const image = parent.find("img").first();
    const playerImages = extractImages(load(parent.html() ?? ""));
    players.set(profileId, {
      sourceId: profileId,
      name: link.text || clean(image.attr("alt") ?? ""),
      url: link.url,
      images: playerImages
    });
  }
  const sections = extractSections($).filter(section => /playing|squad|bench|support staff|coach|team/i.test(section.heading));
  const teamNames = $("h2,h3,h4").toArray().map(el => clean($(el).text())).filter(Boolean);
  return {
    teams: teamNames,
    sections,
    players: [...players.values()],
    images: extractImages($),
    text: getMainText($).slice(0, 20000)
  };
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
  profiles: LinkRecord[]; teams: LinkRecord[]; series: LinkRecord[]; venues: LinkRecord[]; content: LinkRecord[];
} {
  const result = {
    profiles: [] as LinkRecord[],
    teams: [] as LinkRecord[],
    series: [] as LinkRecord[],
    venues: [] as LinkRecord[],
    content: [] as LinkRecord[]
  };
  for (const link of getLinks($, baseUrl)) {
    const identity = classifyCricbuzzEntityUrl(link.url);
    if (identity?.entityType === "player") result.profiles.push(link);
    else if (identity?.entityType === "team") result.teams.push(link);
    else if (identity?.entityType === "series") result.series.push(link);
    else if (identity?.entityType === "venue") result.venues.push(link);
    else if (identity?.entityType === "metadata") result.content.push(link);
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
  const regex = new RegExp(`(?:^|\s)${escaped}\s+([^\\n]{1,250}?)(?=\s+(?:Born|Birth Place|Role|Batting Style|Bowling Style|Teams|Date|Time|Toss|Venue|Umpires|3rd Umpire|Referee|Capacity|Location|Time Zone|Ends|Home To|Floodlights)\s|$)`, "i");
  return clean(text.match(regex)?.[1] ?? "");
}
function parseDateTime(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function num(value: string | undefined): number {
  const parsed = Number.parseFloat((value ?? "").replace(/[^\d.-]/g, ""));
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
async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Cricbuzz page exceeded ${maxBytes} bytes.`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Response exceeded configured size limit").catch(() => undefined);
        throw new Error(`Cricbuzz page exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Small exported seam for deterministic parser tests. */
export function classifyCricbuzzEntityUrl(url: string): { entityType: EntityType; sourceId: string } | undefined {
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { return undefined; }
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "www.cricbuzz.com") return undefined;
  const path = parsedUrl.pathname.replace(/\/+$/, "") || "/";
  const rule = PATH_RULES.find(item => item.pattern.test(path));
  if (!rule) return undefined;
  const match = rule.pattern.exec(path);
  if (!match) return undefined;
  const rawId = rule.type === "team" || rule.kind?.startsWith("team-") ? match[2] : match[1];
  const pathHash = stableHash(path);
  let subpageIdentity: string | undefined;
  if (rule.kind === "team-subpage") {
    subpageIdentity = `${match[2]}:${(match[3] ?? "").toLowerCase()}`;
  } else if (rule.kind === "player-stats") {
    subpageIdentity = `${match[1]}:${path.split("/").filter(Boolean).slice(3).join("/").toLowerCase()}`;
  } else if (rule.kind === "series-subpage") {
    subpageIdentity = `${match[1]}:${(match[2] ?? "").toLowerCase()}`;
  } else if (rule.kind === "player-match-performance") {
    subpageIdentity = `${match[1]}:${match[2]}:${match[3]}`;
  } else if (rule.kind === "series-auction") {
    subpageIdentity = `${(match[1] ?? "").toLowerCase()}:${(match[2] ?? "index").toLowerCase()}`;
  } else if (rule.kind === "video-collection") {
    subpageIdentity = `${match[1]}:${(match[2] ?? "").toLowerCase()}`;
  } else if (rule.kind?.includes("stats")) {
    subpageIdentity = rawId ?? pathHash;
  }
  const sourceId = rule.kind
    ? `${rule.kind}:${subpageIdentity ?? rawId ?? pathHash}`
    : rule.type === "team"
      ? match[2]!
      : rawId ?? `${rule.type}:${pathHash}`;
  return { entityType: rule.type, sourceId };
}

function normalizeCricbuzzPageUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

/** Stable queue identity: aliases share a key, but distinct page families never do. */
export function getCricbuzzCrawlIdentityKey(value: string): string {
  const normalized = normalizeCricbuzzPageUrl(value);
  const identity = classifyCricbuzzEntityUrl(normalized);
  return identity ? `${identity.entityType}:${identity.sourceId}` : `url:${normalized}`;
}

/**
 * Keep the first URL for each stable page identity. Callers should put current
 * sitemap URLs before saved-snapshot URLs so current source slugs win aliases.
 */
export function dedupeCricbuzzPageUrls(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isAllowedCricbuzzPageUrl(value)) continue;
    const normalized = normalizeCricbuzzPageUrl(value);
    const key = getCricbuzzCrawlIdentityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function parseCricbuzzEntityHtml(html: string, url: string): CrikoraEntity | undefined {
  const identity = classifyCricbuzzEntityUrl(url);
  if (!identity) return undefined;
  return parseEntityPage(load(html), url, identity.entityType);
}
