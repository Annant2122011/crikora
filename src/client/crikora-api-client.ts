/**
 * Browser-safe Crikora JSON API client.
 *
 * Use this from the browser extension and website. The API owns source access,
 * caching and Neon credentials; never ship DATABASE_URL or source credentials
 * in a browser bundle.
 */

export interface CrikoraMeta {
  count?: number;
  source?: string;
  retentionSeconds?: number;
  [key: string]: unknown;
}

export interface CrikoraEnvelope<T> {
  data: T;
  meta?: CrikoraMeta;
}

export interface CrikoraHealth {
  ok: boolean;
  service: string;
  source?: string;
  storage?: string;
  retentionSeconds?: number;
}

export type CrikoraMatchStatus = "live" | "upcoming" | "completed";

export interface CrikoraMatch {
  id: string;
  entityType?: "match";
  source?: string;
  sourceMatchId?: string;
  competition?: string;
  homeTeam?: string;
  awayTeam?: string;
  status?: CrikoraMatchStatus;
  format?: string;
  startTime?: string;
  venue?: string;
  innings?: unknown[];
  events?: unknown[];
  images?: Array<{ url: string; alt?: string }>;
  sourceUrl?: string;
  fetchedAt?: string;
  expiresAt?: string;
  ttlSeconds?: number;
  [key: string]: unknown;
}

export interface CrikoraEntity {
  id: string;
  entityType: string;
  sourceUrl?: string;
  fetchedAt?: string;
  expiresAt?: string;
  ttlSeconds?: number;
  [key: string]: unknown;
}

export interface MatchQuery {
  status?: CrikoraMatchStatus;
  limit?: number;
  offset?: number;
}

export interface EntityQuery {
  limit?: number;
  offset?: number;
}

export interface ContentQuery {
  kind?: string;
  limit?: number;
}

export interface CrikoraPlayerComparison {
  players: Array<{
    player: CrikoraEntity;
    playerId: string;
    displayName: string;
    comparisonFields: Record<string, unknown>;
    careerStatistics: unknown[];
  }>;
  comparison: Array<{
    label: string;
    values: Record<string, unknown>;
  }>;
}

export interface CrikoraNewsArticle {
  id: string;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  summary?: string;
  bodyText: string;
  author?: string;
  category?: string;
  publishedAt?: string;
  modifiedAt?: string;
  primaryImageUrl?: string;
  tags: string[];
  observedAt: string;
}

export interface CrikoraScheduleFixture {
  id: string;
  matchSourceId: string;
  sourcePageUrl: string;
  matchUrl: string;
  matchTitle: string;
  homeTeam?: string;
  awayTeam?: string;
  competition: string;
  format: string;
  startTime?: string;
  venue?: string;
  sourceText: string;
  observedAt: string;
}

export interface NewsQuery {
  limit?: number;
  offset?: number;
  before?: string;
}

export interface ScheduleQuery {
  limit?: number;
  offset?: number;
  from?: string;
}

export interface ArchiveCoverage {
  pageKind: string;
  status: string;
  pageCount: number;
  totalFetches: number;
  rawPageVersions: number;
  entityVersions: number;
  rawPageBytes: number;
  storedBytes: number;
  lastFetchedAt: string | null;
}

export interface CrikoraEntitySnapshot {
  id: string;
  entityType: string;
  sourceId: string;
  sourceUrl: string;
  payloadHash: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  observedAt: string;
}

export interface ArchiveHistoryQuery {
  limit?: number;
  before?: string;
}

export interface CrikoraEntityDetails {
  entity: CrikoraEntity | CrikoraEntitySnapshot | null;
  related: CrikoraEntitySnapshot[];
}


export class CrikoraApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "CrikoraApiError";
  }
}

export class CrikoraApiClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetcher: typeof fetch = fetch
  ) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new TypeError("Crikora API base URL must be an absolute HTTP(S) URL.");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new TypeError("Crikora API base URL must be HTTP(S) and must not contain credentials, query parameters or a fragment.");
    }
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
  }

  health(signal?: AbortSignal): Promise<CrikoraHealth> {
    return this.request<CrikoraHealth>("/health", signal);
  }

  listMatches(query: MatchQuery = {}, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraMatch[]>> {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<CrikoraEnvelope<CrikoraMatch[]>>(`/v1/matches${suffix}`, signal);
  }

  listLiveMatches(limit = 500, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraMatch[]>> {
    return this.listByStatus("live", limit, signal);
  }

  listUpcomingMatches(limit = 500, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraMatch[]>> {
    return this.listByStatus("upcoming", limit, signal);
  }

  listRecentMatches(limit = 500, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraMatch[]>> {
    return this.listByStatus("completed", limit, signal);
  }

  getMatch(matchId: string, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraMatch>> {
    return this.request<CrikoraEnvelope<CrikoraMatch>>(
      `/v1/matches/${encodeURIComponent(matchId.replace(/^cricbuzz:/, ""))}`,
      signal
    );
  }

  getMatchEvents(matchId: string, signal?: AbortSignal): Promise<CrikoraEnvelope<unknown[]>> {
    return this.request<CrikoraEnvelope<unknown[]>>(
      `/v1/matches/${encodeURIComponent(matchId.replace(/^cricbuzz:/, ""))}/events`,
      signal
    );
  }

  listPlayers(limit = 100, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("players", limit, 0, signal);
  }

  listTeams(limit = 100, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("teams", limit, 0, signal);
  }

  listSeries(limit = 100, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("series", limit, 0, signal);
  }

  listVenues(limit = 100, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("venues", limit, 0, signal);
  }

  listPlayersPage(query: EntityQuery = {}, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("players", query.limit ?? 100, query.offset ?? 0, signal);
  }

  listTeamsPage(query: EntityQuery = {}, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("teams", query.limit ?? 100, query.offset ?? 0, signal);
  }

  listSeriesPage(query: EntityQuery = {}, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("series", query.limit ?? 100, query.offset ?? 0, signal);
  }

  listVenuesPage(query: EntityQuery = {}, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("venues", query.limit ?? 100, query.offset ?? 0, signal);
  }

  getEntity(entityType: string, sourceId: string, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity>> {
    return this.request<CrikoraEnvelope<CrikoraEntity>>(
      `/v1/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(sourceId)}`,
      signal
    );
  }

  listContent(query: ContentQuery = {}, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<CrikoraEnvelope<CrikoraEntity[]>>(`/v1/content${suffix}`, signal);
  }

  comparePlayers(playerIds: string[], signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraPlayerComparison>> {
    if (playerIds.length < 2 || playerIds.length > 4 || playerIds.some(id => !/^\d{1,12}$/.test(id))) {
      throw new TypeError("Player comparison requires 2 to 4 numeric Cricbuzz player IDs.");
    }
    const params = new URLSearchParams({ ids: playerIds.join(",") });
    return this.request<CrikoraEnvelope<CrikoraPlayerComparison>>(
      `/v1/players/compare?${params.toString()}`,
      signal
    );
  }

  listNews(query: NewsQuery = {}, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraNewsArticle[]>> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    if (query.before) params.set("before", query.before);
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<CrikoraEnvelope<CrikoraNewsArticle[]>>(`/v1/news${suffix}`, signal);
  }

  getNews(articleId: string, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraNewsArticle>> {
    return this.request<CrikoraEnvelope<CrikoraNewsArticle>>(
      `/v1/news/${encodeURIComponent(articleId.replace(/^news:/, ""))}`,
      signal
    );
  }

  listSchedule(query: ScheduleQuery = {}, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraScheduleFixture[]>> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    if (query.from) params.set("from", query.from);
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<CrikoraEnvelope<CrikoraScheduleFixture[]>>(`/v1/schedule${suffix}`, signal);
  }

  search(query: string, limit = 30, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return this.request<CrikoraEnvelope<CrikoraEntity[]>>(`/v1/search?${params.toString()}`, signal);
  }


  getEntityDetails(
    entityType: string,
    sourceId: string,
    limit = 100,
    signal?: AbortSignal
  ): Promise<CrikoraEnvelope<CrikoraEntityDetails>> {
    const params = new URLSearchParams({ limit: String(limit) });
    return this.request<CrikoraEnvelope<CrikoraEntityDetails>>(
      `/v1/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(sourceId)}/details?${params.toString()}`,
      signal
    );
  }

  getArchiveCoverage(signal?: AbortSignal): Promise<CrikoraEnvelope<ArchiveCoverage[]>> {
    return this.request<CrikoraEnvelope<ArchiveCoverage[]>>("/v1/archive/coverage", signal);
  }

  listArchivedEntities(
    entityType: string,
    query: ArchiveHistoryQuery = {},
    signal?: AbortSignal
  ): Promise<CrikoraEnvelope<CrikoraEntitySnapshot[]>> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.before) params.set("before", query.before);
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<CrikoraEnvelope<CrikoraEntitySnapshot[]>>(
      `/v1/archive/entities/${encodeURIComponent(entityType)}${suffix}`,
      signal
    );
  }

  getEntityHistory(
    entityType: string,
    sourceId: string,
    query: ArchiveHistoryQuery = {},
    signal?: AbortSignal
  ): Promise<CrikoraEnvelope<CrikoraEntitySnapshot[]>> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.before) params.set("before", query.before);
    const suffix = params.size ? `?${params.toString()}` : "";
    return this.request<CrikoraEnvelope<CrikoraEntitySnapshot[]>>(
      `/v1/archive/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(sourceId)}/history${suffix}`,
      signal
    );
  }

  private listByStatus(
    status: CrikoraMatchStatus,
    limit: number,
    signal?: AbortSignal
  ): Promise<CrikoraEnvelope<CrikoraMatch[]>> {
    return this.listMatches({ status, limit }, signal);
  }

  private listEntities(
    entity: string,
    limit: number,
    offset = 0,
    signal?: AbortSignal
  ): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return this.request<CrikoraEnvelope<CrikoraEntity[]>>(`/v1/${entity}?${params.toString()}`, signal);
  }

  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        signal
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new Error("Unable to reach the Crikora API.", { cause: error });
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : `Crikora API request failed with HTTP ${response.status}.`;
      throw new CrikoraApiError(message, response.status, body);
    }
    if (body === undefined) throw new Error("Crikora API returned an invalid JSON response.");
    return body as T;
  }
}
