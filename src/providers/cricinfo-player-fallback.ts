export interface CricinfoPlayerLookupInput {
  fullName: string;
  country?: string;
  gender?: string;
}

export interface CricinfoPlayerSupplement {
  playerId: string;
  fullName: string;
  profileUrl: string;
  imageUrl?: string;
  headshotImageUrl?: string;
  sourceData: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface TeamRecord {
  id: string;
  name: string;
  gender?: "male" | "female";
}

interface PlayerSearchRecord {
  id: string;
  slug: string;
  fullName: string;
  gender?: string;
  raw: JsonRecord;
}

interface SearchPage {
  total: number;
  results: PlayerSearchRecord[];
}

const TEAM_URL = "https://hs-consumer-api.espncricinfo.com/v1/pages/team";
const PLAYER_SEARCH_URL = "https://hs-consumer-api.espncricinfo.com/v1/pages/player/search";
const PLAYER_HOME_URL = "https://hs-consumer-api.espncricinfo.com/v1/pages/player/home";
const IMAGE_BASE_URL = "https://img1.hscicdn.com/image/upload/lsci";

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;
}

function normalizeName(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function nameParts(value: string): string[] {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(part => part.length > 1);
}

function namesMatch(expected: string, actual: string): boolean {
  const left = normalizeName(expected);
  const right = normalizeName(actual);
  if (left && left === right) return true;
  const expectedParts = nameParts(expected);
  const actualParts = nameParts(actual);
  return expectedParts.length >= 2 && actualParts.length >= 2 &&
    expectedParts[0] === actualParts[0] &&
    expectedParts[expectedParts.length - 1] === actualParts[actualParts.length - 1];
}

function countryKey(value: string): string {
  const key = normalizeName(value)
    .replace(/womens|women|female|mens|men|male|cricketteam|team/g, "");
  const aliases: Record<string, string> = {
    wi: "westindies",
    windies: "westindies",
    uae: "unitedarabemirates",
    usa: "unitedstates",
    us: "unitedstates",
    png: "papuanewguinea"
  };
  return aliases[key] ?? key;
}

function genderKey(value?: string): "male" | "female" | undefined {
  const normalized = (value ?? "").toLowerCase();
  if (/women|female|girls?|\bf\b/.test(normalized)) return "female";
  if (/men|male|boys?|\bm\b/.test(normalized)) return "male";
  return undefined;
}

function playerRecord(value: unknown): PlayerSearchRecord | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const id = textValue(raw.objectId ?? raw.playerId ?? raw.id);
  const fullName = textValue(raw.longName ?? raw.fullName ?? raw.name);
  if (!id || !fullName) return undefined;
  return {
    id,
    slug: textValue(raw.slug) ?? fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    fullName,
    gender: textValue(raw.gender),
    raw
  };
}

function teamRecords(payload: JsonRecord): TeamRecord[] {
  const content = asRecord(payload.content) ?? payload;
  const featured = asRecord(content.featuredTeamsGroups) ??
    asRecord(payload.featuredTeamsGroups);
  const groups = Array.isArray(featured?.groups) ? featured.groups : [];
  const output = new Map<string, TeamRecord>();

  for (const groupValue of groups) {
    const group = asRecord(groupValue);
    if (!group || !Array.isArray(group.teams)) continue;
    const groupTitle = textValue(group.title ?? group.name) ?? "";
    const groupGender = genderKey(groupTitle);
    for (const teamValue of group.teams) {
      const team = asRecord(teamValue);
      if (!team) continue;
      const id = textValue(team.objectId ?? team.teamId ?? team.id);
      const name = textValue(team.longName ?? team.name ?? team.title);
      if (!id || !name) continue;
      output.set(id, { id, name, ...(groupGender ? { gender: groupGender } : {}) });
    }
  }

  return [...output.values()];
}

function searchPage(payload: JsonRecord): SearchPage {
  const content = asRecord(payload.content);
  const records = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(content?.results)
      ? content.results
      : [];
  const total = Number(payload.total ?? content?.total ?? records.length);
  return {
    total: Number.isFinite(total) && total > 0 ? Math.floor(total) : records.length,
    results: records.map(playerRecord).filter((item): item is PlayerSearchRecord => Boolean(item))
  };
}

function normalizeImage(value: unknown): string | undefined {
  const raw = textValue(value);
  if (!raw) return undefined;
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return `https:${raw}`;
  const path = raw.replace(/^\/+/, "");
  if (!path) return undefined;
  return path.startsWith("lsci/")
    ? `https://img1.hscicdn.com/image/upload/${path}`
    : `${IMAGE_BASE_URL}/${path}`;
}

function playerImage(player: JsonRecord, searchRecord: JsonRecord): {
  imageUrl?: string;
  headshotImageUrl?: string;
} {
  const headshot = asRecord(player.headshotImage) ?? asRecord(searchRecord.headshotImage);
  const imageUrl = normalizeImage(player.imageUrl ?? searchRecord.imageUrl);
  const headshotImageUrl = normalizeImage(headshot?.url);
  return {
    ...(imageUrl ? { imageUrl } : {}),
    ...(headshotImageUrl ? { headshotImageUrl } : {})
  };
}

function abortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Cricinfo lookup aborted."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Cricinfo lookup aborted."));
    }, { once: true });
  });
}

/**
 * Narrow fallback for player profiles that lack a usable Cricbuzz photo.
 * It resolves the player through ESPNcricinfo's public team/player index and
 * fetches one player-home payload. It does not crawl the general Cricinfo site.
 */
export class CricinfoPlayerFallback {
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly recordsPerPage: number;
  private readonly maxBinarySearchPages: number;
  private lastRequestAt = 0;
  private teamsPromise?: Promise<TeamRecord[]>;
  private readonly pageCache = new Map<string, SearchPage>();

  constructor(options: {
    fetcher?: Fetcher;
    timeoutMs?: number;
    minRequestIntervalMs?: number;
    recordsPerPage?: number;
    maxBinarySearchPages?: number;
  } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 900;
    this.recordsPerPage = options.recordsPerPage ?? 40;
    this.maxBinarySearchPages = options.maxBinarySearchPages ?? 16;
  }

  async lookup(
    input: CricinfoPlayerLookupInput,
    signal?: AbortSignal
  ): Promise<CricinfoPlayerSupplement | undefined> {
    const fullName = input.fullName.trim();
    const country = input.country?.trim();
    if (!fullName || !country) return undefined;

    const wantedGender = genderKey(input.gender);
    const candidates = (await this.getTeams(signal)).filter(team =>
      countryKey(team.name) === countryKey(country) &&
      (!wantedGender || !team.gender || team.gender === wantedGender)
    );
    if (!candidates.length) return undefined;

    const matches = new Map<string, PlayerSearchRecord>();
    for (const team of candidates.slice(0, 4)) {
      const found = await this.findPlayerInTeam(team, fullName, signal);
      if (found && (!wantedGender || !genderKey(found.gender) || genderKey(found.gender) === wantedGender)) {
        matches.set(found.id, found);
      }
    }
    if (matches.size !== 1) return undefined;

    const found = [...matches.values()][0]!;
    const detailsUrl = new URL(PLAYER_HOME_URL);
    detailsUrl.searchParams.set("playerId", found.id);
    const details = await this.getJson(detailsUrl, signal);
    const detailsRecord = asRecord(details);
    if (!detailsRecord) return undefined;
    const player = asRecord(detailsRecord.player) ??
      asRecord(asRecord(detailsRecord.content)?.player) ??
      detailsRecord;
    const playerId = textValue(player.objectId ?? player.playerId ?? found.id) ?? found.id;
    const slug = textValue(player.slug) ?? found.slug;
    const resolvedName = textValue(player.longName ?? player.fullName ?? player.name) ?? found.fullName;
    const images = playerImage(player, found.raw);
    const profileUrl = `https://www.espncricinfo.com/cricketers/${slug}-${playerId}`;

    return {
      playerId,
      fullName: resolvedName,
      profileUrl,
      ...images,
      sourceData: {
        searchRecord: found.raw,
        playerHome: detailsRecord
      }
    };
  }

  private getTeams(signal?: AbortSignal): Promise<TeamRecord[]> {
    this.teamsPromise ??= this.getJson(new URL(TEAM_URL), signal).then(payload => {
      const record = asRecord(payload);
      return record ? teamRecords(record) : [];
    }).catch(error => {
      this.teamsPromise = undefined;
      throw error;
    });
    return this.teamsPromise;
  }

  private async findPlayerInTeam(
    team: TeamRecord,
    fullName: string,
    signal?: AbortSignal
  ): Promise<PlayerSearchRecord | undefined> {
    const formats: Array<"INTERNATIONAL" | undefined> = ["INTERNATIONAL", undefined];
    for (const format of formats) {
      const firstPage = await this.getPlayerSearchPage(team.id, 1, format, signal);
      const direct = firstPage.results.find(item =>
        namesMatch(fullName, item.fullName) &&
        (!genderKey(item.gender) || !team.gender || genderKey(item.gender) === team.gender)
      );
      if (direct) return direct;

      const pageCount = Math.ceil(firstPage.total / this.recordsPerPage);
      if (pageCount <= 1) continue;
      let low = 2;
      let high = Math.min(pageCount, 100_000);
      let steps = 0;

      while (low <= high && steps < this.maxBinarySearchPages) {
        steps += 1;
        const middle = Math.floor((low + high) / 2);
        const page = await this.getPlayerSearchPage(team.id, middle, format, signal);
        const match = page.results.find(item =>
          namesMatch(fullName, item.fullName) &&
          (!genderKey(item.gender) || !team.gender || genderKey(item.gender) === team.gender)
        );
        if (match) return match;
        const first = page.results[0]?.fullName;
        const last = page.results.at(-1)?.fullName;
        if (!first || !last) break;
        const targetKey = normalizeName(fullName);
        const firstKey = normalizeName(first);
        const lastKey = normalizeName(last);
        if (targetKey < firstKey) high = middle - 1;
        else if (targetKey > lastKey) low = middle + 1;
        else break;
      }
    }
    return undefined;
  }

  private async getPlayerSearchPage(
    teamId: string,
    page: number,
    format: "INTERNATIONAL" | undefined,
    signal?: AbortSignal
  ): Promise<SearchPage> {
    const cacheKey = `${teamId}:${format ?? "ALL"}:${page}`;
    const cached = this.pageCache.get(cacheKey);
    if (cached) return cached;
    const url = new URL(PLAYER_SEARCH_URL);
    url.searchParams.set("mode", "BOTH");
    url.searchParams.set("page", String(page));
    url.searchParams.set("records", String(this.recordsPerPage));
    url.searchParams.set("filterActive", "false");
    url.searchParams.set("filterTeamId", teamId);
    url.searchParams.set("sort", "ALPHA_ASC");
    if (format) url.searchParams.set("filterFormatLevel", format);
    const result = searchPage(asRecord(await this.getJson(url, signal)) ?? {});
    this.pageCache.set(cacheKey, result);
    return result;
  }

  private async getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    await wait(this.minRequestIntervalMs - (Date.now() - this.lastRequestAt), signal);
    this.lastRequestAt = Date.now();
    const response = await this.fetcher(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        origin: "https://www.espncricinfo.com",
        pragma: "no-cache",
        referer: "https://www.espncricinfo.com/",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
      },
      redirect: "follow",
      cache: "no-store",
      signal: abortSignal(signal, this.timeoutMs)
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      throw new Error(
        `ESPNcricinfo returned HTTP ${response.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""} for ${url.pathname}.`
      );
    }
    return response.json();
  }
}
