import type { CheerioAPI } from "cheerio";

export interface NormalizedBattingRow {
  playerName: string;
  playerSourceId?: string;
  dismissal?: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  strikeRate?: number;
  notOut: boolean;
}

export interface NormalizedBowlingRow {
  playerName: string;
  playerSourceId?: string;
  overs: string;
  maidens: number;
  runs: number;
  wickets: number;
  noBalls?: number;
  wides?: number;
  economy?: number;
}

export interface NormalizedExtras {
  total: number;
  byes: number;
  legByes: number;
  wides: number;
  noBalls: number;
  penalty: number;
}

export interface NormalizedPartnership {
  partnershipNumber: number;
  batterOne?: string;
  batterTwo?: string;
  runs: number;
  balls?: number;
  description?: string;
}

export interface NormalizedFallOfWicket {
  wicketNumber: number;
  score?: number;
  batterName?: string;
  over?: string;
  description: string;
}

export interface NormalizedInnings {
  inningsNumber: number;
  teamName?: string;
  runs?: number;
  wickets?: number;
  overs?: string;
  extras: NormalizedExtras;
  batters: NormalizedBattingRow[];
  bowlers: NormalizedBowlingRow[];
  partnerships: NormalizedPartnership[];
  fallOfWickets: NormalizedFallOfWicket[];
}

export interface NormalizedDelivery {
  sourceEventId: string;
  inningsNumber: number;
  overNumber?: number;
  ballNumber?: number;
  batter?: string;
  nonStriker?: string;
  bowler?: string;
  batRuns: number;
  extraRuns: number;
  totalRuns: number;
  extraType?: string;
  isWicket: boolean;
  dismissalType?: string;
  dismissedPlayer?: string;
  fielder?: string;
  description?: string;
  commentary?: string;
  eventType?: string;
  rawData: Record<string, unknown>;
}

export interface NormalizedCommentary {
  sourceEventId: string;
  inningsNumber: number;
  overNumber?: number;
  ballNumber?: number;
  eventType?: string;
  batter?: string;
  bowler?: string;
  description?: string;
  commentary: string;
  rawData: Record<string, unknown>;
}

export interface NormalizedMatchData {
  schemaVersion: 1;
  innings: NormalizedInnings[];
  deliveries: NormalizedDelivery[];
  commentary: NormalizedCommentary[];
  coverage: {
    scorecard: boolean;
    deliveries: boolean;
    commentary: boolean;
    deliveryCompleteness: "present-unverified" | "not-exposed";
    sources: string[];
  };
}

export interface NormalizedPlayerAttribute {
  fieldPath: string;
  sourceLabel: string;
  section?: string;
  value: string | number | boolean | Record<string, unknown> | unknown[];
  valueType: "text" | "numeric" | "date" | "boolean" | "json";
}

export interface NormalizedPlayerStatistic {
  tableIndex: number;
  rowIndex: number;
  section?: string;
  rowLabel?: string;
  metricLabel: string;
  metricKey: string;
  valueText: string;
  valueNumeric?: number;
}

export interface NormalizedPlayerProfile {
  schemaVersion: 1;
  fullName?: string;
  country?: string;
  role?: string;
  battingStyle?: string;
  bowlingStyle?: string;
  birthDate?: string;
  birthPlace?: string;
  heightCm?: number;
  biography?: string;
  profileImageUrl?: string;
  teams: string[];
  attributes: NormalizedPlayerAttribute[];
  statistics: NormalizedPlayerStatistic[];
}

type DataRecord = Record<string, unknown>;

const clean = (value: string): string => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const keyOf = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const asRecord = (value: unknown): DataRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as DataRecord : undefined;
const asString = (value: unknown): string | undefined => {
  if (typeof value === "string" && clean(value)) return clean(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};
const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const found = value.replace(/,/g, "").match(/^-?\d+(?:\.\d+)?$/);
    if (found) return Number(found[0]);
  }
  return undefined;
};
const scalar = (record: DataRecord, aliases: string[]): unknown => {
  const wanted = new Set(aliases.map(keyOf));
  for (const [key, value] of Object.entries(record)) if (wanted.has(keyOf(key)) && value !== null && value !== undefined) return value;
  return undefined;
};
const stringField = (record: DataRecord, aliases: string[]): string | undefined => {
  const value = scalar(record, aliases);
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join(", ") || undefined;
  return asString(value);
};
const numberField = (record: DataRecord, aliases: string[]): number | undefined => {
  const value = scalar(record, aliases);
  return asNumber(value);
};
const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
};

function walkRecords(value: unknown, visit: (record: DataRecord) => void, depth = 0, seen = new Set<object>()): void {
  if (depth > 40 || !value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) walkRecords(child, visit, depth + 1, seen);
    return;
  }
  const record = value as DataRecord;
  visit(record);
  for (const child of Object.values(record)) walkRecords(child, visit, depth + 1, seen);
}

function parseOverBall(record: DataRecord): { over?: number; ball?: number } {
  const rawOver = scalar(record, ["overNumber", "overNum", "overNo", "over"]);
  const rawBall = scalar(record, ["ballNumber", "ballNum", "ballNo", "deliveryNumber", "ball"]);
  const overText = asString(rawOver);
  const notation = overText?.match(/^(\d+)\.(\d+)$/) ?? asString(rawBall)?.match(/^(\d+)\.(\d+)$/);
  if (notation) return { over: Number(notation[1]), ball: Number(notation[2]) };
  return {
    over: asNumber(rawOver),
    ball: asNumber(rawBall)
  };
}

function parseInningsNumber(record: DataRecord): number {
  const value = scalar(record, ["inningsNumber", "inningsNo", "inningNumber", "innings", "inning"]);
  const explicit = asNumber(value);
  if (explicit && explicit > 0) return Math.trunc(explicit);
  const text = asString(value) ?? "";
  const ordinal = text.match(/(1st|2nd|3rd|4th|first|second|third|fourth)/i)?.[1]?.toLowerCase();
  return ordinal ? ({ "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4 } as Record<string, number>)[ordinal] ?? 1 : 1;
}

function parseExtrasText(value: string): NormalizedExtras {
  const total = Number(value.match(/(?:extras?)\s*[:]?\s*(\d+)/i)?.[1] ?? value.match(/^(\d+)/)?.[1] ?? 0);
  const pick = (patterns: RegExp[]): number => {
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match?.[1]) return Number(match[1]);
    }
    return 0;
  };
  return {
    total,
    byes: pick([/\b(?:b|byes)\s*[: ]\s*(\d+)/i]),
    legByes: pick([/\b(?:lb|leg[- ]byes)\s*[: ]\s*(\d+)/i]),
    wides: pick([/\b(?:w|wd|wides)\s*[: ]\s*(\d+)/i]),
    noBalls: pick([/\b(?:nb|no[- ]balls)\s*[: ]\s*(\d+)/i]),
    penalty: pick([/\b(?:p|penalty)\s*[: ]\s*(\d+)/i])
  };
}

function extrasFromRecord(record: DataRecord): NormalizedExtras {
  const value = asRecord(scalar(record, ["extras", "extraRuns", "extrasData", "extra"])) ?? {};
  const text = stringField(record, ["extrasText", "extrasString"]) ?? "";
  const byes = numberField(value, ["byes", "b"]) ?? parseExtrasText(text).byes;
  const legByes = numberField(value, ["legByes", "legbye", "lb"]) ?? parseExtrasText(text).legByes;
  const wides = numberField(value, ["wides", "wide", "wd", "w"]) ?? parseExtrasText(text).wides;
  const noBalls = numberField(value, ["noBalls", "noballs", "nb"]) ?? parseExtrasText(text).noBalls;
  const penalty = numberField(value, ["penalty", "penaltyRuns", "p"]) ?? parseExtrasText(text).penalty;
  const total = numberField(value, ["total", "totalExtras", "runs"]) ??
    numberField(record, ["totalExtras", "extrasTotal", "extraRuns", "extras"]) ??
    (byes + legByes + wides + noBalls + penalty);
  return { total, byes, legByes, wides, noBalls, penalty };
}

function addInnings(map: Map<number, NormalizedInnings>, inningsNumber: number, teamName?: string): NormalizedInnings {
  let item = map.get(inningsNumber);
  if (!item) {
    item = {
      inningsNumber,
      ...(teamName ? { teamName } : {}),
      extras: { total: 0, byes: 0, legByes: 0, wides: 0, noBalls: 0, penalty: 0 },
      batters: [],
      bowlers: [],
      partnerships: [],
      fallOfWickets: []
    };
    map.set(inningsNumber, item);
  } else if (!item.teamName && teamName) item.teamName = teamName;
  return item;
}

function parseHtmlScorecard($: CheerioAPI, inningsMap: Map<number, NormalizedInnings>): void {
  let currentInnings = 1;
  let currentMode: "batting" | "bowling" = "batting";
  const rows = $("div.cb-scrd-hdr-rw,div.cb-col-100.cb-scrd-hdr-rw,div.cb-scrd-sub-hdr-rw,div.cb-col-100.cb-scrd-sub-hdr-rw,div.cb-scrd-itms,div.cb-col-100.cb-scrd-itms,div.cb-scrd-rw,div.cb-col-100.cb-scrd-rw").toArray();

  for (const element of rows) {
    const node = $(element);
    const classes = node.attr("class") ?? "";
    const text = clean(node.text());
    if (!text) continue;
    if (classes.includes("scrd-hdr-rw") && /innings/i.test(text)) {
      const number = text.match(/(1st|2nd|3rd|4th|first|second|third|fourth)/i)?.[1]?.toLowerCase();
      currentInnings = number ? ({ "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4 } as Record<string, number>)[number] ?? currentInnings : currentInnings;
      const score = text.match(/(\d{1,3})\s*[-/]\s*(\d{1,2})\s*\((\d+(?:\.\d+)?)\s*(?:ov|overs?)/i);
      const teamName = clean(text.replace(/\s+(?:1st|2nd|3rd|4th|first|second|third|fourth)\s+innings.*$/i, ""));
      const innings = addInnings(inningsMap, currentInnings, teamName || undefined);
      if (score) {
        innings.runs = Number(score[1]);
        innings.wickets = Number(score[2]);
        innings.overs = score[3];
      }
      continue;
    }
    if (classes.includes("scrd-sub-hdr-rw")) {
      if (/bowler/i.test(text)) currentMode = "bowling";
      else if (/batter|batsman|batting/i.test(text)) currentMode = "batting";
      continue;
    }
    if (!classes.includes("scrd-itms") && !classes.includes("scrd-rw")) continue;

    const innings = addInnings(inningsMap, currentInnings);
    const cells = node.children().toArray().map(child => clean($(child).text()));
    const first = cells[0] ?? "";
    if (/^extras?\b/i.test(text)) {
      innings.extras = parseExtrasText(text);
      continue;
    }
    if (/^total\b/i.test(text)) {
      const total = text.match(/(\d+)\s*[-/]\s*(\d+)\s*\((\d+(?:\.\d+)?)\s*(?:ov|overs?)/i);
      if (total) {
        innings.runs = Number(total[1]);
        innings.wickets = Number(total[2]);
        innings.overs = total[3];
      } else {
        const runs = text.match(/total\s*[: ]\s*(\d+)/i)?.[1];
        if (runs) innings.runs = Number(runs);
      }
      continue;
    }
    if (/^fall of wickets\b/i.test(text)) {
      const matches = [...text.matchAll(/(\d+)\s*[-/]\s*(\d+)\s*\(([^)]*)\)/g)];
      for (const match of matches) {
        const detail = clean(match[3] ?? "");
        innings.fallOfWickets.push({
          wicketNumber: innings.fallOfWickets.length + 1,
          score: Number(match[1]),
          batterName: detail.split(",")[0]?.trim(),
          over: detail.match(/(\d+(?:\.\d+)?)/)?.[1],
          description: detail
        });
      }
      continue;
    }
    if (/^partnership\b/i.test(text) || classes.includes("partnership")) {
      const value = text.match(/partnership\s*[:]?\s*(\d+)\s*(?:\((\d+)\s*balls?\))?/i);
      innings.partnerships.push({
        partnershipNumber: innings.partnerships.length + 1,
        runs: Number(value?.[1] ?? text.match(/\b(\d+)\b/)?.[1] ?? 0),
        balls: value?.[2] ? Number(value[2]) : undefined,
        description: text
      });
      continue;
    }
    if (!first || /^(Batter|Bowler|Extras|Total|Fall of Wickets|Partnerships|Yet to Bat)$/i.test(first)) continue;

    const playerLink = node.find("a[href*='/profiles/']").first();
    const playerName = clean(playerLink.text() || first);
    const playerUrl = playerLink.attr("href") ?? "";
    const playerSourceId = playerUrl.match(/\/profiles\/(\d+)/)?.[1];
    if (currentMode === "bowling") {
      const numeric = cells.slice(1).map(value => value.match(/^\d+(?:\.\d+)?$/) ? Number(value) : undefined);
      if (playerName && numeric.length >= 4 && numeric[0] !== undefined) {
        const values = numeric.filter((value): value is number => value !== undefined);
        innings.bowlers.push({
          playerName,
          ...(playerSourceId ? { playerSourceId } : {}),
          overs: cells[1] ?? "0",
          maidens: numeric[1] ?? 0,
          runs: numeric[2] ?? 0,
          wickets: numeric[3] ?? 0,
          ...(numeric.length > 4 ? { noBalls: numeric[4] } : {}),
          ...(numeric.length > 5 ? { wides: numeric[5] } : {}),
          ...(values.length ? { economy: values.at(-1) } : {})
        });
      }
    } else {
      const numeric = cells.slice(2).map(value => value.match(/^\d+(?:\.\d+)?$/) ? Number(value) : undefined);
      const dismissal = cells[1];
      if (playerName && numeric.length >= 4 && numeric[0] !== undefined) {
        innings.batters.push({
          playerName,
          ...(playerSourceId ? { playerSourceId } : {}),
          dismissal: dismissal || undefined,
          runs: numeric[0] ?? 0,
          balls: numeric[1] ?? 0,
          fours: numeric[2] ?? 0,
          sixes: numeric[3] ?? 0,
          ...(numeric.length > 4 && numeric[4] !== undefined ? { strikeRate: numeric[4] } : {}),
          notOut: /not out|batting/i.test(text) || /not out/i.test(dismissal ?? "")
        });
      }
    }
  }

  // Plain HTML tables appear on older scorecard variants and are parsed by their header labels.
  $("table").each((_tableIndex, table) => {
    const tableNode = $(table);
    const headerRow = tableNode.find("tr").filter((_i, row) => $(row).find("th").length > 0).first();
    const headers = headerRow.find("th").toArray().map(cell => clean($(cell).text()));
    if (!headers.length) return;
    const normalizedHeaders = headers.map(keyOf);
    const tableText = clean(tableNode.text());
    const inningsNumber = parseInningsNumber({ innings: tableNode.prevAll("h1,h2,h3,h4").first().text() });
    const innings = addInnings(inningsMap, inningsNumber);
    const batterIndex = normalizedHeaders.findIndex(header => /^(batter|batsman|striker)$/.test(header));
    const bowlerIndex = normalizedHeaders.findIndex(header => header === "bowler");
    if (batterIndex >= 0) {
      tableNode.find("tr").each((_i, row) => {
        const cells = $(row).find("th,td").toArray().map(cell => clean($(cell).text()));
        if (cells.length !== headers.length || cells[batterIndex] === headers[batterIndex]) return;
        const get = (aliases: string[]): string => {
          const index = normalizedHeaders.findIndex(header => aliases.includes(header));
          return index >= 0 ? cells[index] ?? "" : "";
        };
        const runs = Number(get(["r", "runs"]) || 0);
        innings.batters.push({
          playerName: cells[batterIndex] ?? "",
          dismissal: get(["dismissal", "howout"]) || undefined,
          runs, balls: Number(get(["b", "balls"]) || 0),
          fours: Number(get(["4s", "fours"]) || 0),
          sixes: Number(get(["6s", "sixes"]) || 0),
          strikeRate: Number(get(["sr", "strikerate"]) || 0),
          notOut: /not out|batting/i.test(cells.join(" "))
        });
      });
    } else if (bowlerIndex >= 0) {
      tableNode.find("tr").each((_i, row) => {
        const cells = $(row).find("th,td").toArray().map(cell => clean($(cell).text()));
        if (cells.length !== headers.length || cells[bowlerIndex] === headers[bowlerIndex]) return;
        const get = (aliases: string[]): string => {
          const index = normalizedHeaders.findIndex(header => aliases.includes(header));
          return index >= 0 ? cells[index] ?? "" : "";
        };
        innings.bowlers.push({
          playerName: cells[bowlerIndex] ?? "",
          overs: get(["o", "overs"]),
          maidens: Number(get(["m", "maidens"]) || 0),
          runs: Number(get(["r", "runs"]) || 0),
          wickets: Number(get(["w", "wkts", "wickets"]) || 0),
          noBalls: Number(get(["nb", "noballs"]) || 0),
          wides: Number(get(["wd", "wides"]) || 0),
          economy: Number(get(["econ", "economy"]) || 0)
        });
      });
    } else if (normalizedHeaders.some(header => header.includes("partnership"))) {
      tableNode.find("tr").each((_i, row) => {
        const cells = $(row).find("th,td").toArray().map(cell => clean($(cell).text()));
        if (cells.length <= headers.length) {
          partnershipIndex++;
          innings.partnerships.push({ partnershipNumber: partnershipIndex, runs: Number(cells[1] ?? 0), description: cells.join(" | ") });
        }
      });
    }
    void tableText;
  });
}

function flattenProfileAttributes(value: unknown, path: string, section: string | undefined, attributes: NormalizedPlayerAttribute[], depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;
  const record = asRecord(value);
  if (record) {
    for (const [key, child] of Object.entries(record)) {
      const nextPath = path ? path + "." + key : key;
      const nextSection = /bio|about|career|personal|summary|profile/i.test(key) ? key : section;
      flattenProfileAttributes(child, nextPath, nextSection, attributes, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => flattenProfileAttributes(child, path + "[" + index + "]", section, attributes, depth + 1));
    return;
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
  const stringValue = String(value).trim();
  if (!stringValue) return;
  let valueType: NormalizedPlayerAttribute["valueType"] = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "numeric" : "text";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) valueType = "date";
  attributes.push({
    fieldPath: path,
    sourceLabel: path.split(".").at(-1) ?? path,
    ...(section ? { section } : {}),
    value,
    valueType
  });
}

function profileValue(source: DataRecord[], aliases: string[]): string | undefined {
  const wanted = new Set(aliases.map(keyOf));
  for (const record of source) {
    const sourceLabel = asString(scalar(record, ["label", "fieldLabel", "displayLabel"]));
    if (sourceLabel && wanted.has(keyOf(sourceLabel))) {
      const labelled = asString(scalar(record, ["value", "text", "displayValue"]));
      if (labelled) return labelled;
    }
    const value = stringField(record, aliases);
    if (value) return value;
  }
  return undefined;
}

function parseBirthDate(value?: string): string | undefined {
  if (!value) return undefined;
  const iso = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const formats = [
    /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i,
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i
  ];
  const match = formats.map(pattern => value.match(pattern)).find(Boolean);
  if (!match) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

export function normalizeCricbuzzPlayerProfile(
  $: CheerioAPI,
  pageUrl: string,
  serverComponents?: unknown
): NormalizedPlayerProfile {
  const labels: DataRecord[] = [];
  const addLabel = (label: string, value: string, section?: string) => {
    if (label && value) labels.push({ label, value, ...(section ? { section } : {}) });
  };
  $("tr").each((_i, element) => {
    const cells = $(element).find("th,td").toArray().map(cell => clean($(cell).text())).filter(Boolean);
    if (cells.length >= 2 && cells[0]!.length < 100) addLabel(cells[0]!, cells.slice(1).join(" | "), "table");
  });
  $("dt").each((_i, element) => addLabel(clean($(element).text()), clean($(element).next("dd").text()), "definition-list"));
  $("[data-label]").each((_i, element) => {
    const node = $(element);
    addLabel(clean(node.attr("data-label") ?? ""), clean(node.text()), node.attr("data-section"));
  });
  const rscRoots: unknown[] = [];
  walkRecords(serverComponents, record => {
    for (const [key, value] of Object.entries(record)) {
      if (/^(playerData|playerInfo|playerProfile|profileData|bioData)$/i.test(key)) rscRoots.push(value);
    }
  });
  const rscRecords: DataRecord[] = [];
  for (const root of rscRoots) walkRecords(root, record => rscRecords.push(record));
  const allRecords = [...rscRecords, ...labels];
  const values = (aliases: string[]) => profileValue(allRecords, aliases);
  const sections = $("h1,h2,h3,h4").toArray().map(heading => {
    const node = $(heading);
    return { heading: clean(node.text()), text: clean(node.nextUntil("h1,h2,h3,h4").text()) };
  }).filter(section => section.heading && section.text);
  const biography = sections.filter(section => /bio|about|career|summary|early life|profile/i.test(section.heading))
    .map(section => section.text).join("\n\n") ||
    values(["biography", "bio", "description", "playerDescription", "summary"]);
  const image = $("meta[property='og:image']").attr("content") ||
    $("img[alt]").filter((_i, element) => /player|profile/i.test($(element).attr("alt") ?? "")).first().attr("src") ||
    $("img[alt]").first().attr("src");
  const teamValue = values(["teams", "team", "currentTeams", "domesticTeams"]);
  const teams = teamValue ? teamValue.split(/[,;|]/).map(clean).filter(Boolean) : [];
  const attributes: NormalizedPlayerAttribute[] = [];
  for (const record of allRecords) {
    const section = asString(scalar(record, ["section", "category", "group"]));
    const label = asString(scalar(record, ["label", "name", "key", "title"]));
    const value = scalar(record, ["value", "text", "displayValue"]);
    if (label && value !== undefined && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      const itemValue = typeof value === "string" ? clean(value) : value;
      if (String(itemValue)) attributes.push({
        fieldPath: label.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        sourceLabel: label,
        ...(section ? { section } : {}),
        value: itemValue,
        valueType: typeof itemValue === "number" ? "numeric" : typeof itemValue === "boolean" ? "boolean" :
          (/^\d{4}-\d{2}-\d{2}$/.test(String(itemValue)) || (/born|birth|date/i.test(label) && Boolean(parseBirthDate(String(itemValue))))) ? "date" : "text"
      });
    } else {
      flattenProfileAttributes(record, "", section, attributes);
    }
  }
  const uniqueAttributes = [...new Map(attributes.map(attribute => [attribute.fieldPath + ":" + String(attribute.value), attribute])).values()];
  const statistics: NormalizedPlayerStatistic[] = [];
  $("table").each((tableIndex, table) => {
    const rows = $(table).find("tr").toArray().map(row => $(row).find("th,td").toArray().map(cell => clean($(cell).text())));
    const headers = rows[0] ?? [];
    rows.slice(1).forEach((row, rowIndex) => {
      const rowLabel = row[0];
      row.slice(1).forEach((value, columnIndex) => {
        const metricLabel = headers[columnIndex + 1] ?? "value_" + (columnIndex + 1);
        const numeric = asNumber(value);
        statistics.push({
          tableIndex, rowIndex,
          ...(headers[0] ? { rowLabel } : {}),
          metricLabel,
          metricKey: keyOf(metricLabel),
          valueText: value,
          ...(numeric !== undefined ? { valueNumeric: numeric } : {})
        });
      });
    });
  });
  const birthPlace = values(["birthPlace", "birthplace", "placeOfBirth", "bornIn", "birthLocation"]);
  const height = values(["height", "heightCm"]);
  const heightNumber = height ? Number(height.match(/\d+(?:\.\d+)?/)?.[0]) : undefined;
  return {
    schemaVersion: 1,
    fullName: values(["fullName", "name", "playerName"]) || clean($("h1").first().text()) || undefined,
    country: values(["country", "nationality", "internationalTeam", "countryName"]),
    role: values(["role", "playingRole", "playerRole"]),
    battingStyle: values(["battingStyle", "batStyle"]),
    bowlingStyle: values(["bowlingStyle", "bowlStyle"]),
    birthDate: parseBirthDate(values(["dateOfBirth", "dob", "born"])),
    birthPlace,
    ...(heightNumber !== undefined ? { heightCm: /m$/.test(height ?? "") && heightNumber < 3 ? heightNumber * 100 : heightNumber } : {}),
    biography,
    ...(image ? { profileImageUrl: new URL(image, pageUrl).toString() } : {}),
    teams,
    attributes: uniqueAttributes,
    statistics
  };
}

function collectStructuredRecords(root: unknown, predicate: (record: DataRecord) => boolean): DataRecord[] {
  const result: DataRecord[] = [];
  walkRecords(root, record => {
    if (predicate(record) && result.length < 5000) result.push(record);
  });
  return result;
}

function normalizeStructuredDelivery(record: DataRecord, matchId: string): NormalizedDelivery | undefined {
  const { over, ball } = parseOverBall(record);
  const commentary = stringField(record, ["commentary", "commText", "comment", "description", "eventDescription", "text", "event"]);
  const batter = stringField(record, ["batsmanStriker", "striker", "batter", "batsman", "batsmanName", "strikerName"]);
  const bowler = stringField(record, ["bowler", "bowlerName", "bowlingPlayer"]);
  const batRuns = numberField(record, ["batRuns", "batsmanRuns", "batterRuns", "runsOffBat"]) ?? 0;
  const extras = extrasFromRecord(record);
  const explicitTotal = numberField(record, ["totalRuns", "totalRun", "score", "deliveryRuns"]);
  const totalRuns = explicitTotal ?? batRuns + extras.total;
  const dismissalType = stringField(record, ["dismissalType", "wicketType", "dismissal", "howOut", "kind"]);
  const wicketFlag = scalar(record, ["isWicket", "wicket", "out"]);
  const explicitWicket = wicketFlag === true ||
    (typeof wicketFlag === "number" && wicketFlag > 0) ||
    (typeof wicketFlag === "string" && /^(?:true|yes|1|out|wicket)$/i.test(wicketFlag.trim()));
  const isWicket = explicitWicket ||
    Boolean(dismissalType && !/not out|none|false/i.test(dismissalType)) ||
    /\b(?:OUT|WICKET|CAUGHT|BOWLED|LBW|RUN OUT|STUMPED|HIT WICKET)\b/i.test(commentary ?? "");
  if (over === undefined && ball === undefined && !commentary) return undefined;
  if (!commentary && !batter && !bowler && over === undefined) return undefined;
  const inningsNumber = parseInningsNumber(record);
  const explicitId = stringField(record, ["sourceEventId", "eventId", "commentaryId", "deliveryId", "id", "key"]);
  const hasDeliveryIdentity = ball !== undefined || Boolean(explicitId) ||
    (over !== undefined && Boolean(batter && bowler));
  if (!hasDeliveryIdentity) return undefined;
  const signature = [matchId, inningsNumber, over ?? "", ball ?? "", batter ?? "", bowler ?? "", commentary ?? "", JSON.stringify(record)].join("|");
  return {
    sourceEventId: explicitId || matchId + ":" + inningsNumber + ":" + (over ?? "x") + "." + (ball ?? "x") + ":" + stableHash(signature),
    inningsNumber,
    ...(over !== undefined ? { overNumber: over } : {}),
    ...(ball !== undefined ? { ballNumber: ball } : {}),
    ...(batter ? { batter } : {}),
    ...(stringField(record, ["nonStriker", "nonStrikerName", "batsmanNonStriker"]) ? { nonStriker: stringField(record, ["nonStriker", "nonStrikerName", "batsmanNonStriker"]) } : {}),
    ...(bowler ? { bowler } : {}),
    batRuns,
    extraRuns: extras.total,
    totalRuns,
    ...(stringField(record, ["extraType", "extrasType", "extra"]) ? { extraType: stringField(record, ["extraType", "extrasType", "extra"]) } : {}),
    isWicket,
    ...(dismissalType ? { dismissalType } : {}),
    ...(stringField(record, ["dismissedPlayer", "playerOut", "outBatsman"]) ? { dismissedPlayer: stringField(record, ["dismissedPlayer", "playerOut", "outBatsman"]) } : {}),
    ...(stringField(record, ["fielder", "fielderName", "catcher"]) ? { fielder: stringField(record, ["fielder", "fielderName", "catcher"]) } : {}),
    ...(stringField(record, ["description", "eventDescription"]) ? { description: stringField(record, ["description", "eventDescription"]) } : {}),
    ...(commentary ? { commentary } : {}),
    ...(stringField(record, ["eventType", "type", "kind"]) ? { eventType: stringField(record, ["eventType", "type", "kind"]) } : {}),
    rawData: record
  };
}

function normalizeCommentary(record: DataRecord, matchId: string): NormalizedCommentary | undefined {
  const commentary = stringField(record, ["commentary", "commText", "comment", "description", "eventDescription", "text"]);
  if (!commentary) return undefined;
  const { over, ball } = parseOverBall(record);
  const inningsNumber = parseInningsNumber(record);
  const id = stringField(record, ["sourceEventId", "eventId", "commentaryId", "id", "key"]);
  const signature = [matchId, inningsNumber, over ?? "", ball ?? "", commentary].join("|");
  return {
    sourceEventId: id || matchId + ":commentary:" + stableHash(signature),
    inningsNumber,
    ...(over !== undefined ? { overNumber: over } : {}),
    ...(ball !== undefined ? { ballNumber: ball } : {}),
    ...(stringField(record, ["eventType", "type", "kind"]) ? { eventType: stringField(record, ["eventType", "type", "kind"]) } : {}),
    ...(stringField(record, ["batter", "batsman", "striker", "batsmanStriker"]) ? { batter: stringField(record, ["batter", "batsman", "striker", "batsmanStriker"]) } : {}),
    ...(stringField(record, ["bowler", "bowlerName"]) ? { bowler: stringField(record, ["bowler", "bowlerName"]) } : {}),
    ...(stringField(record, ["description", "eventDescription"]) ? { description: stringField(record, ["description", "eventDescription"]) } : {}),
    commentary,
    rawData: record
  };
}

function parseHtmlCommentary($: CheerioAPI, matchId: string): { deliveries: NormalizedDelivery[]; commentary: NormalizedCommentary[] } {
  const deliveries: NormalizedDelivery[] = [];
  const commentary: NormalizedCommentary[] = [];
  const selectors = "[data-event-id],[data-commentary-id],[data-over][data-ball],.cb-com-ln,.cb-comm";
  $(selectors).each((_index, element) => {
    const node = $(element);
    const text = clean(node.text());
    if (!text) return;
    const over = node.attr("data-over") ?? text.match(/\b(\d{1,2}\.\d{1,2})\b/)?.[1];
    const innings = Number(node.attr("data-innings") ?? 1);
    const record: DataRecord = {
      id: node.attr("data-event-id") ?? node.attr("data-commentary-id"),
      over,
      inningsNumber: Number.isFinite(innings) && innings > 0 ? innings : 1,
      commentary: text,
      eventType: /\b(?:wicket|out|bowled|lbw|caught|run out|stumped)\b/i.test(text) ? "wicket" :
        /\bSIX\b/i.test(text) ? "six" : /\bFOUR\b/i.test(text) ? "four" : "commentary"
    };
    const item = normalizeCommentary(record, matchId);
    if (item) commentary.push(item);
    const delivery = normalizeStructuredDelivery(record, matchId);
    if (delivery) deliveries.push(delivery);
  });
  return { deliveries, commentary };
}


function recordList(value: unknown): DataRecord[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((item): item is DataRecord => Boolean(item));
  const record = asRecord(value);
  if (!record) return [];
  return Object.values(record).map(asRecord).filter((item): item is DataRecord => Boolean(item));
}

function firstRecord(record: DataRecord, aliases: string[]): DataRecord | undefined {
  return asRecord(scalar(record, aliases));
}

function structuredPlayerId(record: DataRecord, aliases: string[]): string | undefined {
  const value = scalar(record, aliases);
  const text = asString(value);
  return text && /^\d+$/.test(text) ? text : undefined;
}

function parseStructuredInnings(root: unknown, inningsMap: Map<number, NormalizedInnings>): void {
  const candidates = collectStructuredRecords(root, record =>
    ["batTeamDetails", "bowlTeamDetails", "partnershipsData", "wicketsData", "batTeamScore", "inningsRuns"]
      .some(key => Object.prototype.hasOwnProperty.call(record, key))
  );
  for (const record of candidates) {
    const number = parseInningsNumber(record);
    const batting = firstRecord(record, ["batTeamDetails", "battingTeamDetails", "batting"]);
    const bowling = firstRecord(record, ["bowlTeamDetails", "bowlingTeamDetails", "bowling"]);
    const score = firstRecord(record, ["scoreDetails", "inningsScore", "score"]);
    const teamName = stringField(record, ["batTeamName", "teamName", "battingTeam"]) ??
      stringField(batting ?? {}, ["batTeamName", "teamName", "name"]);
    const inning = addInnings(inningsMap, number, teamName);
    const runs = numberField(record, ["inningsRuns", "totalRuns", "inningsTotal", "totalScore"]) ??
      numberField(score ?? {}, ["runs", "score", "totalRuns"]) ??
      numberField(batting ?? {}, ["runs", "score", "totalRuns"]);
    const wickets = numberField(record, ["inningsWickets", "wickets"]) ??
      numberField(score ?? {}, ["wickets", "wicketsLost"]) ??
      numberField(batting ?? {}, ["wickets", "wicketsLost"]);
    const overs = stringField(record, ["overs", "oversBowled", "oversCompleted"]) ??
      stringField(score ?? {}, ["overs", "oversBowled"]) ??
      stringField(batting ?? {}, ["overs", "oversBowled"]);
    if (runs !== undefined) inning.runs = runs;
    if (wickets !== undefined) inning.wickets = wickets;
    if (overs) inning.overs = overs;

    const batters = recordList(scalar(batting ?? record, ["batsmenData", "batsmen", "batters", "batterDetails", "batsmanList"]));
    for (const batter of batters) {
      const name = stringField(batter, ["batName", "batsmanName", "playerName", "name", "batter"]);
      if (!name) continue;
      const playerSourceId = structuredPlayerId(batter, ["batId", "batsmanId", "playerId", "id"]);
      const row: NormalizedBattingRow = {
        playerName: name,
        ...(playerSourceId ? { playerSourceId } : {}),
        ...(stringField(batter, ["outDesc", "outString", "dismissal", "howOut", "dismissalText"]) ? {
          dismissal: stringField(batter, ["outDesc", "outString", "dismissal", "howOut", "dismissalText"])
        } : {}),
        runs: numberField(batter, ["runs", "batRuns", "runsScored"]) ?? 0,
        balls: numberField(batter, ["balls", "ballsFaced", "ballFaced"]) ?? 0,
        fours: numberField(batter, ["fours", "four", "4s"]) ?? 0,
        sixes: numberField(batter, ["sixes", "six", "6s"]) ?? 0,
        ...(numberField(batter, ["strikeRate", "strike_rate", "sr"]) !== undefined ? {
          strikeRate: numberField(batter, ["strikeRate", "strike_rate", "sr"])
        } : {}),
        notOut: Boolean(scalar(batter, ["isNotOut", "notOut", "batting"])) ||
          /not out|retired hurt|batting/i.test(stringField(batter, ["outDesc", "outString", "dismissal"]) ?? "")
      };
      const existingIndex = inning.batters.findIndex(item =>
        (row.playerSourceId && item.playerSourceId === row.playerSourceId) || item.playerName === row.playerName
      );
      if (existingIndex >= 0) inning.batters[existingIndex] = row;
      else inning.batters.push(row);
    }

    const bowlers = recordList(scalar(bowling ?? record, ["bowlersData", "bowlers", "bowlerDetails", "bowlingList"]));
    for (const bowler of bowlers) {
      const name = stringField(bowler, ["bowlName", "bowlerName", "playerName", "name", "bowler"]);
      if (!name) continue;
      const playerSourceId = structuredPlayerId(bowler, ["bowlId", "bowlerId", "playerId", "id"]);
      const row: NormalizedBowlingRow = {
        playerName: name,
        ...(playerSourceId ? { playerSourceId } : {}),
        overs: stringField(bowler, ["overs", "oversBowled", "o"]) ?? "0",
        maidens: numberField(bowler, ["maidens", "maidenOvers", "m"]) ?? 0,
        runs: numberField(bowler, ["runs", "conceded", "runsConceded", "r"]) ?? 0,
        wickets: numberField(bowler, ["wickets", "wkts", "w"]) ?? 0,
        ...(numberField(bowler, ["noBalls", "noballs", "nb"]) !== undefined ? { noBalls: numberField(bowler, ["noBalls", "noballs", "nb"]) } : {}),
        ...(numberField(bowler, ["wides", "wide", "wd"]) !== undefined ? { wides: numberField(bowler, ["wides", "wide", "wd"]) } : {}),
        ...(numberField(bowler, ["economy", "econ", "economyRate"]) !== undefined ? { economy: numberField(bowler, ["economy", "econ", "economyRate"]) } : {})
      };
      const existingIndex = inning.bowlers.findIndex(item =>
        (row.playerSourceId && item.playerSourceId === row.playerSourceId) || item.playerName === row.playerName
      );
      if (existingIndex >= 0) inning.bowlers[existingIndex] = row;
      else inning.bowlers.push(row);
    }

    const extrasRecord = firstRecord(record, ["extrasData", "extras", "extraRuns"]) ??
      firstRecord(score ?? {}, ["extrasData", "extras"]);
    if (extrasRecord) inning.extras = extrasFromRecord({ extras: extrasRecord });

    const partnerships = recordList(scalar(record, ["partnershipsData", "partnerships", "partnershipList"]));
    for (const partnership of partnerships) {
      const runsValue = numberField(partnership, ["totalRuns", "runs", "partnershipRuns", "score"]) ?? 0;
      const batterOne = stringField(partnership, ["bat1Name", "batterOne", "playerOne", "batsman1"]);
      const batterTwo = stringField(partnership, ["bat2Name", "batterTwo", "playerTwo", "batsman2"]);
      const row: NormalizedPartnership = {
        partnershipNumber: numberField(partnership, ["wicketNumber", "partnershipNumber", "number"]) ?? inning.partnerships.length + 1,
        ...(batterOne ? { batterOne } : {}),
        ...(batterTwo ? { batterTwo } : {}),
        runs: runsValue,
        ...(numberField(partnership, ["totalBalls", "balls", "ballsFaced"]) !== undefined ? {
          balls: numberField(partnership, ["totalBalls", "balls", "ballsFaced"])
        } : {}),
        ...(stringField(partnership, ["description", "text", "summary"]) ? {
          description: stringField(partnership, ["description", "text", "summary"])
        } : {})
      };
      const existingIndex = inning.partnerships.findIndex(item => item.partnershipNumber === row.partnershipNumber);
      if (existingIndex >= 0) inning.partnerships[existingIndex] = row;
      else inning.partnerships.push(row);
    }

    const wicketsData = recordList(scalar(record, ["wicketsData", "fallOfWickets", "wicketDetails", "wickets"]));
    for (const wicket of wicketsData) {
      const wicketNumber = numberField(wicket, ["wktNbr", "wicketNumber", "number", "wicket"]) ?? inning.fallOfWickets.length + 1;
      const scoreValue = numberField(wicket, ["wktRuns", "score", "runsAtWicket", "runs"]);
      const batterName = stringField(wicket, ["batName", "batter", "batsman", "playerName", "name"]);
      const over = stringField(wicket, ["wktOver", "over", "overNumber"]);
      const description = stringField(wicket, ["description", "outDesc", "text"]) ??
        [batterName, scoreValue !== undefined ? "at " + scoreValue : "", over ? "over " + over : ""].filter(Boolean).join(" ");
      const row: NormalizedFallOfWicket = {
        wicketNumber,
        ...(scoreValue !== undefined ? { score: scoreValue } : {}),
        ...(batterName ? { batterName } : {}),
        ...(over ? { over } : {}),
        description
      };
      const existingIndex = inning.fallOfWickets.findIndex(item => item.wicketNumber === wicketNumber);
      if (existingIndex >= 0) inning.fallOfWickets[existingIndex] = row;
      else inning.fallOfWickets.push(row);
    }
  }
}

export function parseCricbuzzMatchData(
  matchId: string,
  scorecard: CheerioAPI | undefined,
  commentaryPage: CheerioAPI | undefined,
  serverComponents?: unknown
): NormalizedMatchData {
  const inningsMap = new Map<number, NormalizedInnings>();
  if (scorecard) parseHtmlScorecard(scorecard, inningsMap);
  parseStructuredInnings(serverComponents, inningsMap);
  const roots = collectStructuredRecords(serverComponents, record =>
    Object.keys(record).some(key => /^(scorecard|scorecardData|innings|batTeamDetails|bowlTeamDetails|commentaryPageData|commentaryList|commentaryData|ballByBall|deliveries|partnerships|partnership|extras)$/i.test(key))
  );
  const deliveries = new Map<string, NormalizedDelivery>();
  const commentary = new Map<string, NormalizedCommentary>();
  for (const root of roots) {
    const candidates = collectStructuredRecords(root, record =>
      (scalar(record, ["overNumber", "overNum", "overNo", "over", "ballNumber", "ballNum", "ballNo"]) !== undefined ||
        scalar(record, ["commentary", "commText", "description", "eventDescription"]) !== undefined) &&
      (scalar(record, ["batsmanStriker", "batter", "batsman", "bowler", "bowlerName", "commentary", "commText", "description", "eventDescription"]) !== undefined)
    );
    for (const record of candidates) {
      const delivery = normalizeStructuredDelivery(record, matchId);
      if (delivery) deliveries.set(delivery.sourceEventId, delivery);
      const comment = normalizeCommentary(record, matchId);
      if (comment) commentary.set(comment.sourceEventId, comment);
      // Innings summary fields are normalized separately above. A delivery's
      // totalRuns/wickets/extras must never overwrite the innings aggregate.
    }
  }
  if (commentaryPage) {
    const html = parseHtmlCommentary(commentaryPage, matchId);
    for (const item of html.deliveries) if (!deliveries.has(item.sourceEventId)) deliveries.set(item.sourceEventId, item);
    for (const item of html.commentary) if (!commentary.has(item.sourceEventId)) commentary.set(item.sourceEventId, item);
  }
  const innings = [...inningsMap.values()].sort((a, b) => a.inningsNumber - b.inningsNumber);
  const deliveryRows = [...deliveries.values()].sort((a, b) =>
    a.inningsNumber - b.inningsNumber ||
    (a.overNumber ?? 0) - (b.overNumber ?? 0) ||
    (a.ballNumber ?? 0) - (b.ballNumber ?? 0));
  const commentaryRows = [...commentary.values()].sort((a, b) =>
    a.inningsNumber - b.inningsNumber ||
    (a.overNumber ?? 0) - (b.overNumber ?? 0) ||
    (a.ballNumber ?? 0) - (b.ballNumber ?? 0));
  const sources = [
    ...(scorecard ? ["scorecard-html"] : []),
    ...(commentaryPage ? ["commentary-html"] : []),
    ...(serverComponents ? ["react-server-components"] : [])
  ];
  return {
    schemaVersion: 1,
    innings,
    deliveries: deliveryRows,
    commentary: commentaryRows,
    coverage: {
      scorecard: innings.length > 0,
      deliveries: deliveryRows.length > 0,
      commentary: commentaryRows.length > 0,
      deliveryCompleteness: deliveryRows.length > 0 ? "present-unverified" : "not-exposed",
      sources: [...new Set(sources)]
    }
  };
}

export function getPlayerSourceIdFromUrl(value: string): string | undefined {
  try { return new URL(value).pathname.match(/^\/profiles\/(\d+)/)?.[1]; } catch { return undefined; }
}
