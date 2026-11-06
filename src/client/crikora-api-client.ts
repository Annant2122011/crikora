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
}

export interface ContentQuery {
  kind?: string;
  limit?: number;
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
    return this.listEntities("players", limit, signal);
  }

  listTeams(limit = 100, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("teams", limit, signal);
  }

  listSeries(limit = 100, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("series", limit, signal);
  }

  listVenues(limit = 100, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    return this.listEntities("venues", limit, signal);
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

  search(query: string, limit = 30, signal?: AbortSignal): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return this.request<CrikoraEnvelope<CrikoraEntity[]>>(`/v1/search?${params.toString()}`, signal);
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
    signal?: AbortSignal
  ): Promise<CrikoraEnvelope<CrikoraEntity[]>> {
    const params = new URLSearchParams({ limit: String(limit) });
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
