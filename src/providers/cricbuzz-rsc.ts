/**
 * Decode Cricbuzz's Next.js React Server Component flight payload.
 * Raw HTML is retained separately so this evidence can be reprocessed if the format changes.
 */
export interface CricbuzzFlightPayload {
  rowCount: number;
  rows: Record<string, unknown>;
  keyedData: Record<string, unknown[]>;
}

const CHUNK = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/gs;
const ROW_ID = /^[0-9a-f]+$/i;
const INTERESTING_KEYS = [
  "playerData", "playerInfo", "playerProfile", "profileData", "bioData", "playerDetails",
  "playerStats", "careerStats", "battingStats", "bowlingStats", "personalInfo", "playerBiography",
  "matchInfo", "matchHeader", "miniscore", "commentaryPageData",
  "seriesInfoData", "matchesData", "pointsTableData", "teamInfo", "venueDetails",
  "graphsData", "initialStats", "playerNews", "storyList", "squads", "team1", "team2",
  "scorecardApiData", "scoreCard", "scorecardData", "scorecard",
  "innings", "batTeamDetails", "bowlTeamDetails", "partnerships", "partnershipsData",
  "wicketsData", "wicketInfo", "extrasData", "commentaryData", "commentaryList", "ballByBall",
  "deliveries", "overSummary", "batTeamScore", "bowlTeamScore", "batsmenData", "bowlersData",
  "matchPreviewFullComm", "matchDetails", "matchScoreDetails", "inningsScoreList", "commentarySnippetList", "overSummaryList"
];

function resolveReferences(
  value: unknown,
  rows: Record<string, unknown>,
  depth = 0,
  visited: Set<string> = new Set()
): unknown {
  if (depth > 40) return value;
  if (typeof value === "string" && value.startsWith("$")) {
    if (value === "$undefined") return null;
    const reference = value.slice(1);
    if (/^[0-9a-f]+$/i.test(reference) && rows[reference] !== undefined && !visited.has(reference)) {
      const next = new Set(visited);
      next.add(reference);
      return resolveReferences(rows[reference], rows, depth + 1, next);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => resolveReferences(item, rows, depth + 1, visited));
  if (!value || typeof value !== "object") return value;
  const resolved: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    resolved[key] = resolveReferences(child, rows, depth + 1, visited);
  }
  return resolved;
}

function findValues(
  value: unknown,
  key: string,
  found: unknown[],
  rows: Record<string, unknown>,
  depth = 0
): void {
  if (depth > 32 || found.length >= 50) return;
  if (Array.isArray(value)) {
    for (const child of value) findValues(child, key, found, rows, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, key)) {
    found.push(resolveReferences(record[key], rows));
  }
  for (const child of Object.values(record)) findValues(child, key, found, rows, depth + 1);
}

function parseRows(flight: string): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  const bytes = new TextEncoder().encode(flight);
  let position = 0;
  while (position < bytes.length) {
    const colon = bytes.indexOf(58, position);
    if (colon < 0) break;
    const id = new TextDecoder().decode(bytes.slice(position, colon));
    if (!ROW_ID.test(id)) {
      const newline = bytes.indexOf(10, position);
      if (newline < 0) break;
      position = newline + 1;
      continue;
    }
    position = colon + 1;
    if (bytes[position] === 84) {
      const comma = bytes.indexOf(44, position);
      if (comma < 0) break;
      const length = Number.parseInt(new TextDecoder().decode(bytes.slice(position + 1, comma)), 16);
      if (!Number.isFinite(length) || length < 0 || length > bytes.length) break;
      const end = Math.min(bytes.length, comma + 1 + length);
      rows[id] = new TextDecoder().decode(bytes.slice(comma + 1, end));
      position = end;
      if (bytes[position] === 10) position += 1;
      continue;
    }
    let newline = bytes.indexOf(10, position);
    if (newline < 0) newline = bytes.length;
    const raw = new TextDecoder().decode(bytes.slice(position, newline));
    position = newline + 1;
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        rows[id] = JSON.parse(raw) as unknown;
        continue;
      } catch {
        // Preserve unknown flight rows as text for forensic use.
      }
    }
    rows[id] = raw;
  }
  return rows;
}

export function decodeCricbuzzFlightScripts(scripts: string[]): CricbuzzFlightPayload | undefined {
  const chunks: string[] = [];
  for (const script of scripts) {
    for (const match of script.matchAll(CHUNK)) {
      const encoded = match[1];
      if (!encoded) continue;
      try {
        chunks.push(JSON.parse('"' + encoded + '"') as string);
      } catch {
        // Ignore a malformed chunk and continue decoding the rest of the page.
      }
    }
  }
  if (!chunks.length) return undefined;
  const rows = parseRows(chunks.join(""));
  const keyedData: Record<string, unknown[]> = {};
  for (const key of INTERESTING_KEYS) {
    const values: unknown[] = [];
    for (const row of Object.values(rows)) findValues(row, key, values, rows);
    if (values.length) keyedData[key] = values.slice(0, 50);
  }
  return { rowCount: Object.keys(rows).length, rows, keyedData };
}
