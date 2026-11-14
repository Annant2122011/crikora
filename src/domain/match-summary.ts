import type { CrikoraEntity } from "./entities.js";

export interface MatchSummaryInnings {
  inningsNumber: number;
  teamName: string | null;
  runs: number | null;
  wickets: number | null;
  overs: string | null;
  allOut: boolean;
  declared: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\\d+(?:\\.\\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseToss(tossText: string | null): { tossWinner: string | null; tossDecision: "bat" | "bowl" | "unknown" | null } {
  if (!tossText) return { tossWinner: null, tossDecision: null };
  const winner = tossText.match(/^(.+?)\\s+(?:won|wins)\\s+the\\s+toss\\b/i)?.[1]?.trim() ?? null;
  const choice = tossText.match(/\\b(?:elected|opted|chose|choose|decided)\\s+to\\s+(bat|bowl|field)\\b/i)?.[1]?.toLowerCase();
  const tossDecision = choice === "bat" ? "bat" : choice === "bowl" || choice === "field" ? "bowl" : "unknown";
  return { tossWinner: winner, tossDecision };
}

function parseResult(result: string | null): { winner: string | null; victoryMargin: string | null } {
  if (!result) return { winner: null, victoryMargin: null };
  const match = result.match(/^(.+?)\\s+won\\s+by\\s+(.+?)(?:[.!]\\s*)?$/i);
  return match
    ? { winner: match[1]!.trim(), victoryMargin: match[2]!.trim() }
    : { winner: null, victoryMargin: null };
}

function inferGender(value: string): "men" | "women" | "mixed" | "unknown" {
  if (/\\b(?:women|woman|female|womens|w\u0027s)\\b/i.test(value)) return "women";
  if (/\\b(?:mixed|open\\s+mixed)\\b/i.test(value)) return "mixed";
  if (/\\b(?:men|mens|m\u0027s)\\b/i.test(value)) return "men";
  return "unknown";
}

function inferAgeGroup(value: string): string {
  const youth = value.match(/\\b(?:under[ -]?|u[ -]?)(1[1-9]|2[0-3])\\b/i);
  if (youth?.[1]) return `u${youth[1]}`;
  if (/\\bemerging\\b/i.test(value)) return "emerging";
  if (/\\byouth\\b/i.test(value)) return "youth";
  return "senior";
}

function extractTextInnings(sourceText: string, teams: string[]): MatchSummaryInnings[] {
  const output: MatchSummaryInnings[] = [];
  for (const team of teams) {
    if (!team || /^unknown$/i.test(team)) continue;
    const index = sourceText.toLowerCase().indexOf(team.toLowerCase());
    if (index < 0) continue;
    const segment = sourceText.slice(index, index + 180);
    let score = segment.match(/\\b(\\d{1,3})\\s*\\/\\s*(\\d{1,2})\\s*(?:\\(\\s*(\\d{1,2}(?:\\.\\d)?)\\s*(?:ov|overs?)\\s*\\))?/i);
    let allOut = false;
    let overs: string | null = score?.[3] ?? null;
    if (!score) {
      score = segment.match(/\\b(\\d{1,3})\\s*(?:all[ -]?out)\\s*(?:in\\s*)?(\\d{1,2}(?:\\.\\d)?)\\s*(?:ov|overs?)\\b/i);
      if (score) {
        allOut = true;
        overs = score[2] ?? null;
      }
    }
    if (!score) {
      score = segment.match(/\\b(\\d{1,3})\\s*\\(\\s*(\\d{1,2}(?:\\.\\d)?)\\s*(?:ov|overs?)\\s*\\)/i);
      if (score) overs = score[2] ?? null;
    }
    if (!score) continue;
    const runs = number(score[1]);
    const wickets = allOut ? 10 : number(score[2]);
    output.push({
      inningsNumber: output.length + 1,
      teamName: team,
      runs,
      wickets,
      overs,
      allOut: allOut || wickets === 10,
      declared: /declared/i.test(segment.slice(0, 100))
    });
  }
  return output;
}

/**
 * Build the only match payload allowed into the permanent cache/snapshot layer.
 * Player rows, batting/bowling tables, commentary, raw HTML, RSC blobs, events
 * and other deep details are intentionally discarded here.
 */
export function toCompactMatchPayload(entity: CrikoraEntity): Record<string, unknown> {
  const payload = entity.payload;
  const sourceText = [
    isRecord(payload.stats) ? payload.stats.indexCardText : null,
    isRecord(payload.stats) ? payload.stats.liveSummary : null,
    payload.description,
    payload.result
  ].filter((value): value is string => typeof value === "string").join("\\n");
  const rawInnings = rows(payload.innings).length
    ? rows(payload.innings)
    : isRecord(payload.matchData) ? rows(payload.matchData.innings) : [];
  const innings: MatchSummaryInnings[] = rawInnings.map((item, index) => {
    const runs = number(item.runs);
    const wickets = number(item.wickets);
    const overs = text(item.overs);
    return {
      inningsNumber: number(item.inningsNumber) ?? index + 1,
      teamName: text(item.teamName),
      runs,
      wickets,
      overs,
      allOut: wickets === 10 || /all[ -]?out/i.test(text(item.status) ?? ""),
      declared: Boolean(item.declared)
    };
  });
  if (!innings.length) {
    innings.push(...extractTextInnings(
      sourceText,
      [text(payload.homeTeam) ?? "", text(payload.awayTeam) ?? ""]
    ));
  }

  const tossText = text(payload.toss);
  const toss = parseToss(tossText);
  const result = text(payload.result);
  const resultDetails = parseResult(result);
  const competition = text(payload.competition) ?? "Cricket";
  const identityText = [competition, payload.format, payload.description, payload.homeTeam, payload.awayTeam]
    .filter(value => typeof value === "string").join(" ");
  const status = ["live", "upcoming", "completed"].includes(String(payload.status))
    ? String(payload.status)
    : "upcoming";

  return {
    source: text(payload.source) ?? "cricbuzz",
    sourceMatchId: entity.sourceId,
    competition,
    season: text(payload.season) ?? (text(payload.startTime)?.match(/\\b20\\d{2}\\b/)?.[0] ?? null),
    gender: inferGender(identityText),
    ageGroup: inferAgeGroup(identityText),
    homeTeam: text(payload.homeTeam) ?? "Unknown",
    awayTeam: text(payload.awayTeam) ?? "Unknown",
    status,
    format: text(payload.format) ?? "Unknown",
    startTime: text(payload.startTime),
    venue: text(payload.venue),
    toss: tossText,
    tossWinner: toss.tossWinner,
    tossDecision: toss.tossDecision,
    result,
    winner: resultDetails.winner,
    victoryMargin: resultDetails.victoryMargin,
    playerOfMatch: text(payload.playerOfMatch) ?? text(payload.playerOfTheMatch),
    innings,
    sourceUrl: entity.sourceUrl,
    updatedAt: text(payload.updatedAt) ?? entity.fetchedAt
  };
}
