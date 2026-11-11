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
  batterOneSourceId?: string;
  batterOneRuns?: number;
  batterOneBalls?: number;
  batterTwo?: string;
  batterTwoSourceId?: string;
  batterTwoRuns?: number;
  batterTwoBalls?: number;
  runs: number;
  balls?: number;
  description?: string;
}

export interface NormalizedFallOfWicket {
  wicketNumber: number;
  score?: number;
  batterName?: string;
  playerSourceId?: string;
  dismissalType?: string;
  fielder?: string;
  fielderSourceId?: string;
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
  batterSourceId?: string;
  nonStriker?: string;
  nonStrikerSourceId?: string;
  bowler?: string;
  bowlerSourceId?: string;
  batRuns: number;
  extraRuns: number;
  totalRuns: number;
  extraType?: string;
  extras: NormalizedExtras;
  isWicket: boolean;
  dismissalType?: string;
  dismissedPlayer?: string;
  dismissedPlayerSourceId?: string;
  fielder?: string;
  fielderSourceId?: string;
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
  batterSourceId?: string;
  nonStriker?: string;
  nonStrikerSourceId?: string;
  bowler?: string;
  bowlerSourceId?: string;
  sourceTimestamp?: string;
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
  sourcePath?: string;
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
  biographySections: Array<{ heading: string; text: string }>;
  profileImageUrl?: string;
  teams: string[];
  /** Exact visible source labels retained for API consumers and audit. */
  allFields: Record<string, string>;
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
function displayValue(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (typeof value === "string") return clean(value) || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const values = value.map(item => displayValue(item, depth + 1)).filter((item): item is string => Boolean(item));
    return values.length ? values.join(", ") : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const preferred = scalar(record, ["name", "fullName", "teamName", "shortName", "title", "text", "description", "bio", "value", "url"]);
  if (preferred !== undefined && preferred !== value) {
    const rendered = displayValue(preferred, depth + 1);
    if (rendered) return rendered;
  }
  const values = Object.values(record).map(item => displayValue(item, depth + 1)).filter((item): item is string => Boolean(item));
  return values.length ? values.join(", ") : undefined;
}
const STATISTIC_KEYS = new Set([
  "matches","match","mat","innings","inning","inns","notouts","notout","runs","balls","balls","fours","sixes",
  "average","avg","strikerate","sr","wickets","wkts","economy","econ","maidens","overs","catches","stumpings",
  "runouts","fifties","hundreds","ducks","bestbowling","bestinnings","bestmatch","dotballs","conceded","boundaries",
  "strikeRate","noBalls","wides"
].map(keyOf));
function collectStructuredPlayerStatistics(root: unknown): NormalizedPlayerStatistic[] {
  const output: NormalizedPlayerStatistic[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, path: string, section: string | undefined, depth: number): void => {
    if (depth > 24 || !value || typeof value !== "object" || seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, path + "[" + index + "]", section, depth + 1));
      return;
    }
    const record = value as DataRecord;
    const declaredSection = displayValue(scalar(record, ["format", "formatName", "matchType", "category", "title"]));
    const currentSection = declaredSection || section;
    const metrics = Object.entries(record).filter(([key, item]) =>
      STATISTIC_KEYS.has(keyOf(key)) && (typeof item === "string" || typeof item === "number") && displayValue(item) !== undefined
    );
    if (metrics.length >= 2) {
      const tableIndex = 1000 + Number.parseInt(stableHash(path || JSON.stringify(record)), 36) % 1_000_000;
      const rowLabel = currentSection || displayValue(scalar(record, ["name", "label"])) || undefined;
      for (const [key, item] of metrics) {
        const valueText = displayValue(item) ?? "";
        const numeric = asNumber(item);
        output.push({
          tableIndex, rowIndex: 0,
          ...(currentSection ? { section: currentSection } : {}),
          ...(rowLabel ? { rowLabel } : {}),
          metricLabel: key, metricKey: keyOf(key), sourcePath: path ? path + "." + key : key,
          valueText, ...(numeric !== undefined ? { valueNumeric: numeric } : {})
        });
      }
    }
    for (const [key, child] of Object.entries(record)) {
      const nextSection = /^(test|odi|t20|t20i|first.?class|list.?a|ipl|hundred|the.?hundred|t10|womens?|women|mens?|men)$/i.test(key)
        ? key : currentSection;
      visit(child, path ? path + "." + key : key, nextSection, depth + 1);
    }
  };
  visit(root, "rsc", undefined, 0);
  return output;
}
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
  const rawBall = scalar(record, ["ballNumber", "ballNum", "ballNo", "deliveryNumber", "ball", "overBall", "overAndBall"]);
  const overText = asString(rawOver);
  const notation = overText?.match(/^(\d+)\.(\d+)$/) ?? asString(rawBall)?.match(/^(\d+)\.(\d+)$/);
  if (notation) return { over: Number(notation[1]), ball: Number(notation[2]) };
  const explicitOver = asNumber(rawOver);
  const explicitBall = asNumber(rawBall);
  const ballNbr = numberField(record, ["ballNbr", "ballNumberInInnings", "deliveryNumberInInnings"]);
  if (explicitOver !== undefined || explicitBall !== undefined) {
    const derivedBall = ballNbr !== undefined && ballNbr > 0 ? ((ballNbr - 1) % 6) + 1 : undefined;
    return {
      ...(explicitOver !== undefined ? { over: explicitOver } : ballNbr !== undefined && ballNbr > 0
        ? { over: Math.floor((ballNbr - 1) / 6) } : {}),
      ...(explicitBall !== undefined ? { ball: explicitBall } : derivedBall !== undefined ? { ball: derivedBall } : {})
    };
  }
  if (ballNbr !== undefined && ballNbr > 0) {
    return { over: Math.floor((ballNbr - 1) / 6), ball: ((ballNbr - 1) % 6) + 1 };
  }
  return {};
}

function nestedRecords(record: DataRecord, objectAliases: string[]): DataRecord[] {
  const value = scalar(record, objectAliases);
  if (Array.isArray(value)) return value.map(asRecord).filter((item): item is DataRecord => Boolean(item));
  const nested = asRecord(value);
  return nested ? [nested] : [];
}
function nestedString(record: DataRecord, objectAliases: string[], valueAliases: string[]): string | undefined {
  for (const nested of nestedRecords(record, objectAliases)) {
    const value = stringField(nested, valueAliases);
    if (value) return value;
  }
  return undefined;
}

function nestedNumber(record: DataRecord, objectAliases: string[], valueAliases: string[]): number | undefined {
  for (const nested of nestedRecords(record, objectAliases)) {
    const value = numberField(nested, valueAliases);
    if (value !== undefined) return value;
  }
  return undefined;
}

function descriptionText(record: DataRecord): string | undefined {
  return stringField(record, ["description", "eventDescription", "eventDesc", "shortDescription", "detail", "summary"]);
}
function commentaryText(record: DataRecord): string | undefined {
  const raw = stringField(record, ["commentary", "commText", "comment", "commentaryText", "commentaryTextFormatted", "text"]);
  if (!raw) return undefined;
  const formats = asRecord(scalar(record, ["commentaryFormats", "formats", "commentaryFormat"]));
  if (!formats) return raw;
  let rendered = raw;
  for (const value of Object.values(formats)) {
    const format = asRecord(value);
    if (!format) continue;
    const ids = scalar(format, ["formatId", "id", "placeholder"]);
    const values = scalar(format, ["formatValue", "value", "text", "replacement"]);
    const idList = Array.isArray(ids) ? ids : ids === undefined ? [] : [ids];
    const valueList = Array.isArray(values) ? values : values === undefined ? [] : [values];
    for (let index = 0; index < Math.min(idList.length, valueList.length); index++) {
      if (typeof idList[index] === "string" && typeof valueList[index] === "string") {
        rendered = rendered.split(idList[index] as string).join(valueList[index] as string);
      }
    }
  }
  return clean(rendered);
}
function nestedPlayerId(record: DataRecord, objectAliases: string[], idAliases: string[]): string | undefined {
  for (const nested of nestedRecords(record, objectAliases)) {
    const value = structuredPlayerId(nested, idAliases);
    if (value) return value;
  }
  return undefined;
}

function parseInningsNumber(record: DataRecord): number {
  const value = scalar(record, ["inningsNumber", "inningsNo", "inningNumber", "inningsId", "inningId", "innings", "inning"]);
  const explicit = asNumber(value);
  if (explicit !== undefined && explicit >= 0) return Math.trunc(explicit);
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
  const byes = numberField(value, ["byes", "b"]) ?? numberField(record, ["byes", "byeRuns", "bye"]) ?? parseExtrasText(text).byes;
  const legByes = numberField(value, ["legByes", "legbye", "lb"]) ?? numberField(record, ["legByes", "legByeRuns", "legBye"]) ?? parseExtrasText(text).legByes;
  const wides = numberField(value, ["wides", "wide", "wd", "w"]) ?? numberField(record, ["wides", "wideRuns", "wide"]) ?? parseExtrasText(text).wides;
  const noBalls = numberField(value, ["noBalls", "noballs", "nb", "no_balls"]) ?? numberField(record, ["noBalls", "noballs", "no_balls", "noBallRuns"]) ?? parseExtrasText(text).noBalls;
  const penalty = numberField(value, ["penalty", "penaltyRuns", "p"]) ?? numberField(record, ["penalty", "penaltyRuns"]) ?? parseExtrasText(text).penalty;
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
    const declaredInnings = tableNode.closest("[data-innings]").attr("data-innings");
    const inningsHeading = tableNode.prevAll("h1,h2,h3,h4").first().text();
    const inningsNumber = parseInningsNumber({ innings: declaredInnings ?? inningsHeading });
    const innings = addInnings(inningsMap, inningsNumber);
    const getCell = (cells: string[], aliases: string[]): string => {
      const index = normalizedHeaders.findIndex(header => aliases.includes(header));
      return index >= 0 ? cells[index] ?? "" : "";
    };
    const isExtrasTable = normalizedHeaders.some(header => ["extras","byes","legbyes","wides","noballs","penalty"].includes(header));
    const isWicketTable = normalizedHeaders.some(header => ["wicket","wicketnumber","wkt","scoreatwicket"].includes(header)) &&
      normalizedHeaders.some(header => ["batter","batsman","player","dismissedplayer"].includes(header));
    if (isExtrasTable) {
      const row = tableNode.find("tr").toArray().map(element => $(element).find("th,td").toArray().map(cell => clean($(cell).text())))
        .find(cells => cells.length === headers.length && cells.some((cell, index) => index > 0 && /^\d+$/.test(cell)));
      if (row) {
        const total = Number(getCell(row, ["extras","totalextras","total"]) || 0);
        innings.extras = {
          total,
          byes: Number(getCell(row, ["byes","b","byeruns"]) || 0),
          legByes: Number(getCell(row, ["legbyes","lb","legbyeruns"]) || 0),
          wides: Number(getCell(row, ["wides","wd","wide"]) || 0),
          noBalls: Number(getCell(row, ["noballs","nb","noball"]) || 0),
          penalty: Number(getCell(row, ["penalty","penaltyruns","p"]) || 0)
        };
        if (!innings.extras.total) {
          innings.extras.total = innings.extras.byes + innings.extras.legByes + innings.extras.wides + innings.extras.noBalls + innings.extras.penalty;
        }
      }
    }
    if (isWicketTable) {
      tableNode.find("tr").each((_i, row) => {
        const cells = $(row).find("th,td").toArray().map(cell => clean($(cell).text()));
        if (cells.length !== headers.length || cells.every((cell, index) => cell === headers[index])) return;
        const wicketNumber = Number(getCell(cells, ["wicket","wicketnumber","wkt","number"]) || innings.fallOfWickets.length + 1);
        const score = Number(getCell(cells, ["score","scoreatwicket","runs"]) || 0);
        const batterName = getCell(cells, ["batter","batsman","player","dismissedplayer"]);
        const over = getCell(cells, ["over","overnumber","overs"]);
        const description = getCell(cells, ["description","dismissal","howout"]) || cells.join(" | ");
        innings.fallOfWickets.push({
          wicketNumber, ...(score > 0 ? { score } : {}),
          ...(batterName ? { batterName } : {}), ...(over ? { over } : {}), description
        });
      });
    }
    const batterIndex = normalizedHeaders.findIndex(header => /^(batter|batsman|striker)$/.test(header));
    const bowlerIndex = normalizedHeaders.findIndex(header => header === "bowler");
    if (batterIndex >= 0 && !isWicketTable && !isExtrasTable) {
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
    } else if (normalizedHeaders.some(header => header.includes("partnership")) ||
      (normalizedHeaders.some(header => ["batter1","batterone","batsman1","player1"].includes(header)) &&
       normalizedHeaders.some(header => ["batter2","battertwo","batsman2","player2"].includes(header)))) {
      const runsIndex = normalizedHeaders.findIndex(header => /^(?:r|runs|partnership|partnershipruns|totalruns)$/.test(header));
      const ballsIndex = normalizedHeaders.findIndex(header => /^(?:b|balls|totalballs)$/.test(header));
      const batterOneIndex = normalizedHeaders.findIndex(header => /^(?:batter1|batterone|batsman1|player1)$/.test(header));
      const batterTwoIndex = normalizedHeaders.findIndex(header => /^(?:batter2|battertwo|batsman2|player2)$/.test(header));
      const batterOneRunsIndex = normalizedHeaders.findIndex(header => /^(?:batter1runs|bat1runs|player1runs)$/.test(header));
      const batterTwoRunsIndex = normalizedHeaders.findIndex(header => /^(?:batter2runs|bat2runs|player2runs)$/.test(header));
      const batterOneBallsIndex = normalizedHeaders.findIndex(header => /^(?:batter1balls|bat1balls|player1balls)$/.test(header));
      const batterTwoBallsIndex = normalizedHeaders.findIndex(header => /^(?:batter2balls|bat2balls|player2balls)$/.test(header));
      tableNode.find("tr").each((_i, row) => {
        const cells = $(row).find("th,td").toArray().map(cell => clean($(cell).text()));
        if (cells.length !== headers.length || cells.every((cell, index) => cell === headers[index])) return;
        const runsText = runsIndex >= 0 ? cells[runsIndex] : cells.find(cell => /^\d+$/.test(cell));
        if (!runsText || !/^\d+$/.test(runsText)) return;
        innings.partnerships.push({
          partnershipNumber: innings.partnerships.length + 1,
          ...(batterOneIndex >= 0 && cells[batterOneIndex] ? { batterOne: cells[batterOneIndex] } : {}),
          ...(batterTwoIndex >= 0 && cells[batterTwoIndex] ? { batterTwo: cells[batterTwoIndex] } : {}),
          ...(batterOneRunsIndex >= 0 && /^\d+$/.test(cells[batterOneRunsIndex] ?? "") ? { batterOneRuns: Number(cells[batterOneRunsIndex]) } : {}),
          ...(batterTwoRunsIndex >= 0 && /^\d+$/.test(cells[batterTwoRunsIndex] ?? "") ? { batterTwoRuns: Number(cells[batterTwoRunsIndex]) } : {}),
          ...(batterOneBallsIndex >= 0 && /^\d+$/.test(cells[batterOneBallsIndex] ?? "") ? { batterOneBalls: Number(cells[batterOneBallsIndex]) } : {}),
          ...(batterTwoBallsIndex >= 0 && /^\d+$/.test(cells[batterTwoBallsIndex] ?? "") ? { batterTwoBalls: Number(cells[batterTwoBallsIndex]) } : {}),
          runs: Number(runsText),
          ...(ballsIndex >= 0 && /^\d+$/.test(cells[ballsIndex] ?? "") ? { balls: Number(cells[ballsIndex]) } : {}),
          description: cells.join(" | ")
        });
      });
    }
  });
}

function flattenProfileAttributes(value: unknown, path: string, section: string | undefined, attributes: NormalizedPlayerAttribute[], depth = 0): void {
  if (depth > 16 || value === null || value === undefined) return;
  const sourceLabel = path.split(".").at(-1)?.replace(/\[\d+\]$/, "") ?? path;
  const add = (attributeValue: NormalizedPlayerAttribute["value"], valueType: NormalizedPlayerAttribute["valueType"]) => {
    if (!path) return;
    attributes.push({ fieldPath: path, sourceLabel, ...(section ? { section } : {}), value: attributeValue, valueType });
  };
  const record = asRecord(value);
  if (record) {
    // Store the complete nested value as JSON as well as its searchable leaves.
    add(record, "json");
    for (const [key, child] of Object.entries(record)) {
      const nextPath = path ? path + "." + key : key;
      const nextSection = /bio|about|career|personal|summary|profile|batting|bowling/i.test(key) ? key : section;
      flattenProfileAttributes(child, nextPath, nextSection, attributes, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    add(value, "json");
    value.forEach((child, index) => flattenProfileAttributes(child, path + "[" + index + "]", section, attributes, depth + 1));
    return;
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
  const stringValue = typeof value === "string" ? clean(value) : String(value);
  if (!stringValue) return;
  let normalizedValue: string | number | boolean = value;
  let valueType: NormalizedPlayerAttribute["valueType"] =
    typeof value === "boolean" ? "boolean" : typeof value === "number" ? "numeric" : "text";
  if (typeof value === "string") {
    if (/^(true|false)$/i.test(stringValue)) {
      normalizedValue = /^true$/i.test(stringValue);
      valueType = "boolean";
    } else if (/\d{4}-\d{2}-\d{2}/.test(stringValue)) {
      normalizedValue = stringValue.match(/\d{4}-\d{2}-\d{2}/)![0];
      valueType = "date";
    } else if (/(?:date|dob|birth|born|debut)/i.test(sourceLabel)) {
      const parsedDate = parseBirthDate(stringValue);
      if (parsedDate) { normalizedValue = parsedDate; valueType = "date"; }
    } else if (/^-?\d[\d,]*(?:\.\d+)?$/.test(stringValue)) {
      const numeric = Number(stringValue.replace(/,/g, ""));
      if (Number.isFinite(numeric)) { normalizedValue = numeric; valueType = "numeric"; }
    }
  }
  add(normalizedValue, valueType);
}

function plausiblePlayerName(value?: string): string | undefined {
  const candidate = clean(value ?? "").replace(/\\s+/g, " ");
  if (!candidate || candidate.length > 100 || /\\d/.test(candidate)) return undefined;
  const normalized = keyOf(candidate);
  if (/^(?:t20|twenty20|odi|test|firstclass|lista|format|statistics|stats|playerprofile|cricket|batter|bowler|allrounder|wicketkeeper)$/.test(normalized)) {
    return undefined;
  }
  if (!/[a-z]/i.test(candidate)) return undefined;
  return candidate;
}

function playerNameFromProfileUrl(pageUrl: string): string | undefined {
  try {
    const slug = new URL(pageUrl).pathname.match(/^\\/profiles\\/\\d+\\/([^/]+)/i)?.[1];
    if (!slug) return undefined;
    return slug.split("-").filter(Boolean).map(part =>
      part.length <= 3 && /^[a-z]+$/i.test(part)
        ? part[0]!.toUpperCase() + part.slice(1).toLowerCase()
        : part[0]!.toUpperCase() + part.slice(1).toLowerCase()
    ).join(" ");
  } catch {
    return undefined;
  }
}

function profileValue(source: DataRecord[], aliases: string[]): string | undefined {
  const wanted = new Set(aliases.map(keyOf));
  for (const record of source) {
    const sourceLabel = asString(scalar(record, ["label", "fieldLabel", "displayLabel"]));
    if (sourceLabel && wanted.has(keyOf(sourceLabel))) {
      const labelled = displayValue(scalar(record, ["value", "text", "displayValue"]));
      if (labelled) return labelled;
    }
    const value = displayValue(scalar(record, aliases));
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
  $("div.cb-col-100.cb-col,div.cb-col.cb-col-100,.cb-col-100.cb-col").each((_i, element) => {
    const node = $(element);
    const children = node.children().toArray().map(child => clean($(child).text())).filter(Boolean);
    if (children.length === 2 && children[0]!.length < 100) addLabel(children[0]!, children[1]!, "cricbuzz-label");
  });
  const structuredRoots: unknown[] = [];
  if (serverComponents !== undefined) structuredRoots.push(serverComponents);
  $("script[type='application/ld+json']").each((_i, element) => {
    const content = $(element).contents().text();
    if (!content) return;
    try { structuredRoots.push(JSON.parse(content)); } catch { /* source evidence is retained even when JSON-LD is malformed */ }
  });
  const rscRoots: unknown[] = [];
  walkRecords(structuredRoots, record => {
    for (const [key, value] of Object.entries(record)) {
      if (/^(?:player|profile).*(?:data|info|profile|bio|detail|stat|response|overview)|^(?:bioData|personalInfo|careerStats)$/i.test(key)) rscRoots.push(value);
    }
    const type = asString(scalar(record, ["@type", "type"])) ?? "";
    if (/person|athlete|cricketer|sports?person/i.test(type)) rscRoots.push(record);
  });
  const rscRecords: DataRecord[] = [];
  const seenRsc = new Set<object>();
  for (const root of rscRoots) walkRecords(root, record => {
    if (!seenRsc.has(record)) { seenRsc.add(record); rscRecords.push(record); }
  });
  const allRecords = [...rscRecords, ...labels];
  const values = (aliases: string[]) => profileValue(allRecords, aliases);
  // Do not take a generic `name` from an unrelated format/competition record.
  // Only person-like RSC records or records carrying player-specific fields
  // are eligible to supply a player's name.
  const playerRecords = rscRecords.filter(record => {
    const keys = new Set(Object.keys(record).map(keyOf));
    const type = asString(scalar(record, ["@type", "type"])) ?? "";
    return /person|athlete|cricketer|sports?person/i.test(type) ||
      ["playerid", "playeruid", "fullname", "playername", "battingstyle",
        "bowlingstyle", "playerrole", "dateofbirth", "birthdate"].some(key => keys.has(key));
  });
  const structuredPlayerName = plausiblePlayerName(
    profileValue(playerRecords, ["fullName", "playerName"]) ??
    profileValue(playerRecords, ["name"])
  );
  const personName = plausiblePlayerName(profileValue(
    rscRecords.filter(record => /person|athlete|cricketer|sports?person/i.test(
      asString(scalar(record, ["@type", "type"])) ?? ""
    )),
    ["name", "fullName", "playerName"]
  ));
  const htmlPlayerName = plausiblePlayerName($("h1").first().text());
  const playerName = structuredPlayerName ?? personName ?? htmlPlayerName ?? playerNameFromProfileUrl(pageUrl);
  const htmlSections = $("h1,h2,h3,h4").toArray().map(heading => {
    const node = $(heading);
    const content = node.nextUntil("h1,h2,h3,h4").not("script,style,noscript").text();
    return { heading: clean(node.text()), text: clean(content) };
  }).filter(section => section.heading && section.text);
  const structuredSections = rscRecords.map(record => ({
    heading: stringField(record, ["heading", "sectionTitle", "sectionName", "title", "label"]),
    text: displayValue(scalar(record, ["paragraph", "description", "content", "body", "text", "bio", "value"]))
  })).filter((section): section is { heading: string; text: string } =>
    Boolean(section.heading && section.text && /bio|about|career|summary|early life|profile|personal|background|achievement/i.test(section.heading))
  );
  const sections = [...new Map([...htmlSections, ...structuredSections].map(section =>
    [section.heading.toLowerCase() + ":" + section.text, section]
  )).values()];
  const htmlBiography = sections.filter(section => /bio|about|career|summary|early life|profile|background/i.test(section.heading))
    .map(section => section.text);
  const structuredBiography = values(["biography", "bio", "description", "playerDescription", "summary", "about", "profileDescription"]);
  const biography = [...new Set([...htmlBiography, structuredBiography].filter((value): value is string => Boolean(value)))]
    .join("\n\n");
  const image = $("meta[property='og:image']").attr("content") ||
    $("img[alt]").filter((_i, element) => /player|profile/i.test($(element).attr("alt") ?? "")).first().attr("src") ||
    $("img[alt]").first().attr("src") ||
    values(["image", "profileImage", "profileImageUrl", "faceImage"]);
  const teamValue = values(["teams", "team", "currentTeams", "domesticTeams", "teamNames"]);
  const teams = teamValue ? teamValue.split(/[,;|]/).map(clean).filter(Boolean) : [];
  const attributes: NormalizedPlayerAttribute[] = [];
  // Traverse each source root once, preserving full RSC/JSON-LD paths such as
  // rows.1.playerData.careerStats.ODI.batting.runs instead of losing ancestors.
  for (const root of structuredRoots) flattenProfileAttributes(root, "", undefined, attributes);
  for (const record of labels) {
    const label = asString(scalar(record, ["label", "fieldLabel", "displayLabel"]));
    const value = scalar(record, ["value", "text", "displayValue"]);
    const section = asString(scalar(record, ["section", "category", "group"]));
    if (!label || value === undefined || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) continue;
    const itemValue = typeof value === "string" ? clean(value) : value;
    if (!String(itemValue)) continue;
    attributes.push({
      fieldPath: label.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      sourceLabel: label,
      ...(section ? { section } : {}),
      value: itemValue,
      valueType: typeof itemValue === "number" ? "numeric" : typeof itemValue === "boolean" ? "boolean" :
        (/^\d{4}-\d{2}-\d{2}$/.test(String(itemValue)) || (/born|birth|date/i.test(label) && Boolean(parseBirthDate(String(itemValue))))) ? "date" : "text"
    });
  }
  const allFields: Record<string, string> = {};
  for (const record of allRecords) {
    const label = asString(scalar(record, ["label", "fieldLabel", "displayLabel"]));
    const value = scalar(record, ["value", "text", "displayValue"]);
    if (label && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      allFields[label] = String(value);
    }
  }
  // Keep original source spelling/value (for example DoBFormat) separate from normalized typed values.
  for (const root of structuredRoots) {
    walkRecords(root, record => {
      for (const [key, value] of Object.entries(record)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          allFields[key] ??= String(value);
        }
      }
    });
  }
  // Include every scalar React payload field under its original source key as well as HTML labels.
  for (const attribute of attributes) {
    const serialized = typeof attribute.value === "object" ? JSON.stringify(attribute.value) : String(attribute.value);
    if (attribute.fieldPath) allFields[attribute.fieldPath] ??= serialized;
    if (attribute.sourceLabel) allFields[attribute.sourceLabel] ??= serialized;
  }
  const uniqueAttributes = [...new Map(attributes.map(attribute => [attribute.fieldPath + ":" + JSON.stringify(attribute.value), attribute])).values()];
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
  const structuredStatistics = collectStructuredPlayerStatistics(structuredRoots);
  const uniqueStatistics = [...new Map([...statistics, ...structuredStatistics].map(item =>
    [item.sourcePath ? item.sourcePath + ":" + item.metricKey : item.tableIndex + ":" + item.rowIndex + ":" + item.metricKey, item]
  )).values()];
  const birthPlace = values(["birthPlace", "birthplace", "placeOfBirth", "bornIn", "birthLocation"]);
  const height = values(["height", "heightCm"]);
  const heightNumber = parseHeightCm(height);
  return {
    schemaVersion: 1,
    fullName: playerName,
    country: values(["country", "nationality", "internationalTeam", "intlTeam", "countryName"]),
    role: values(["role", "playingRole", "playerRole"]),
    battingStyle: values(["battingStyle", "batStyle", "bat"]),
    bowlingStyle: values(["bowlingStyle", "bowlStyle", "bowl"]),
    birthDate: parseBirthDate(values(["dateOfBirth", "birthDate", "dob", "dobFormat", "born"])),
    birthPlace,
    ...(heightNumber !== undefined ? { heightCm: /m$/.test(height ?? "") && heightNumber < 3 ? heightNumber * 100 : heightNumber } : {}),
    biography,
    biographySections: sections,
    ...(image ? { profileImageUrl: new URL(image, pageUrl).toString() } : {}),
    teams,
    allFields,
    attributes: uniqueAttributes,
    statistics: uniqueStatistics
  };
}

function parseHeightCm(value?: string): number | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/,/g, ".").trim();
  const centimetres = normalized.match(/(\d+(?:\.\d+)?)\s*(?:cm|centimet(?:er|re)s?)/i);
  if (centimetres) return Number(centimetres[1]);
  const metres = normalized.match(/(\d+(?:\.\d+)?)\s*(?:m|met(?:er|re)s?)(?:\s|$)/i);
  if (metres && Number(metres[1]) < 3) return Number(metres[1]) * 100;
  const feet = normalized.match(/(\d+)\s*(?:ft|feet|foot|')\s*(?:(\d+(?:\.\d+)?)\s*(?:in|inches|")?)?/i);
  if (feet) return Number(feet[1]) * 30.48 + Number(feet[2] ?? 0) * 2.54;
  const plain = asNumber(normalized);
  return plain !== undefined && plain >= 50 && plain <= 300 ? plain : undefined;
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
  const commentary = commentaryText(record);
  const batter = stringField(record, ["batter", "batsman", "striker", "batsmanName", "strikerName", "batsmanStriker"]) ??
    nestedString(record, ["batsmanStriker"], ["batName", "batsmanName", "playerName", "name"]);
  const nonStriker = stringField(record, ["nonStriker", "nonStrikerName", "batsmanNonStriker"]) ??
    nestedString(record, ["batsmanNonStriker", "nonStrikerDetails"], ["batName", "batsmanName", "playerName", "name"]);
  const bowler = stringField(record, ["bowler", "bowlerName", "bowlingPlayer"]) ??
    nestedString(record, ["bowlerStriker"], ["bowlName", "bowlerName", "playerName", "name"]);
  const batRuns = numberField(record, ["batRuns", "batsmanRuns", "batterRuns", "runsOffBat"]) ??
    nestedNumber(record, ["batsmanStriker"], ["batRuns", "runs"]) ?? 0;
  const rawExtras = extrasFromRecord(record);
  const explicitExtraRuns = numberField(record, ["extraRuns", "extrasRuns", "totalExtraRuns", "extraRunsTotal"]);
  const explicitTotal = numberField(record, ["totalRuns", "totalRun", "deliveryRuns"]);
  const totalRuns = explicitTotal ?? batRuns + (explicitExtraRuns ?? rawExtras.total);
  const extraRuns = explicitExtraRuns ?? Math.max(0, totalRuns - batRuns, rawExtras.total);
  const extras: NormalizedExtras = {
    ...rawExtras,
    total: Math.max(rawExtras.total, extraRuns)
  };
  const eventType = stringField(record, ["eventType", "event", "type", "kind"]);
  const wicketCode = stringField(record, ["wicketCode", "dismissalType", "wicketType", "dismissal", "howOut"]) ??
    nestedString(record, ["batsmanStriker"], ["wicketCode", "dismissalType"]);
  const strikerDismissal = nestedString(record, ["batsmanStriker"], ["outDesc", "dismissal", "howOut"]);
  const dismissalContainer = asRecord(scalar(record, ["wicketInfo", "wicketDetails", "dismissalDetails", "wicketData"])) ?? {};
  const dismissalType = wicketCode ?? strikerDismissal ??
    stringField(dismissalContainer, ["wicketType", "dismissalType", "howOut", "description"]);
  const wicketFlag = scalar(record, ["isWicket", "wicket", "out", "wicketFlag"]);
  const explicitWicket = wicketFlag === true ||
    (typeof wicketFlag === "number" && wicketFlag > 0) ||
    (typeof wicketFlag === "string" && /^(?:true|yes|1|out|wicket)$/i.test(wicketFlag.trim()));
  const dismissalIsOut = Boolean(dismissalType && !/^(?:none|false|not out|retired hurt|retired hurt|)$/i.test(dismissalType));
  const eventIsWicket = /(?:^|[,_\s-])(?:WICKET|CAUGHT|BOWLED|LBW|RUN.?OUT|STUMPED|HIT.?WICKET|RETD.?OUT)(?:$|[,_\s-])/i.test(eventType ?? "");
  const negativeCommentary = /\b(?:no wicket|not out|not a wicket|no dismissal|not dismissed)\b/i.test(commentary ?? "");
  const commentaryIsWicket = !negativeCommentary &&
    /\b(?:wicket|out|caught|bowled|lbw|run out|stumped|hit wicket)\b/i.test(commentary ?? "");
  const isWicket = explicitWicket || dismissalIsOut || eventIsWicket || commentaryIsWicket;
  const inningsNumber = parseInningsNumber(record);
  const ballNbr = numberField(record, ["ballNbr", "ballNumberInInnings", "deliveryNumberInInnings"]);
  const explicitId = stringField(record, ["sourceEventId", "eventId", "commentaryId", "deliveryId", "id", "key"]);
  // Cricbuzz uses ballNbr=0 for toss/team notes. They remain commentary records, never deliveries.
  if (ballNbr === 0) return undefined;
  const hasDeliveryIdentity = (ball ?? 0) > 0 || Boolean(explicitId && (batter || bowler || over !== undefined)) ||
    (over !== undefined && Boolean(batter && bowler));
  if (!hasDeliveryIdentity || inningsNumber <= 0) return undefined;
  const signature = [matchId, inningsNumber, over ?? "", ball ?? "", batter ?? "", bowler ?? "", commentary ?? "", JSON.stringify(record)].join("|");
  const batterSourceId = structuredPlayerId(record, ["batterId", "batId", "batsmanId", "strikerId"]) ??
    nestedPlayerId(record, ["batsmanStriker"], ["batId", "batsmanId", "playerId", "id"]);
  const nonStrikerSourceId = structuredPlayerId(record, ["nonStrikerId", "nonStrikerPlayerId"]) ??
    nestedPlayerId(record, ["batsmanNonStriker", "nonStrikerDetails"], ["batId", "batsmanId", "playerId", "id"]);
  const bowlerSourceId = structuredPlayerId(record, ["bowlerId", "bowlId", "bowlerPlayerId"]) ??
    nestedPlayerId(record, ["bowlerStriker"], ["bowlId", "bowlerId", "playerId", "id"]);
  const dismissedPlayer = stringField(record, ["dismissedPlayer", "playerOut", "outBatsman", "batsmanOut"]) ??
    stringField(dismissalContainer, ["playerOut", "dismissedPlayer", "batName", "batsmanName", "name"]);
  const dismissedPlayerSourceId = structuredPlayerId(record, ["dismissedPlayerId", "playerOutId", "outBatsmanId"]) ??
    structuredPlayerId(dismissalContainer, ["playerOutId", "dismissedPlayerId", "batId", "playerId", "id"]) ??
    (isWicket ? batterSourceId : undefined);
  const fielder = stringField(record, ["fielder", "fielderName", "catcher"]) ??
    nestedString(record, ["fielderDetails", "fieldingPlayer", "fielderInfo", "fieldersInvolved"], ["name", "playerName", "fieldingName"]) ??
    nestedString(dismissalContainer, ["fielderDetails", "fieldingPlayer", "fielderInfo", "fieldersInvolved"], ["name", "playerName", "fieldingName"]);
  const fielderSourceId = structuredPlayerId(record, ["fielderId", "catcherId", "fieldingPlayerId"]) ??
    nestedPlayerId(record, ["fielderDetails", "fieldingPlayer", "fielderInfo", "fieldersInvolved"], ["id", "playerId", "fielderId"]) ??
    nestedPlayerId(dismissalContainer, ["fielderDetails", "fieldingPlayer", "fielderInfo", "fieldersInvolved"], ["id", "playerId", "fielderId"]);
  const description = descriptionText(record) ?? stringField(dismissalContainer, ["description", "text"]);
  const explicitExtraType = stringField(record, ["extraType", "extrasType", "extraTypeName"]);
  const inferredExtraType = [
    extras.byes ? "bye" : "",
    extras.legByes ? "leg-bye" : "",
    extras.wides ? "wide" : "",
    extras.noBalls ? "no-ball" : "",
    extras.penalty ? "penalty" : ""
  ].filter(Boolean).join("+");
  return {
    sourceEventId: explicitId || matchId + ":" + inningsNumber + ":" + (over ?? "x") + "." + (ball ?? "x") + ":" + stableHash(signature),
    inningsNumber,
    ...(over !== undefined ? { overNumber: over } : {}),
    ...(ball !== undefined ? { ballNumber: ball } : {}),
    ...(batter ? { batter } : {}),
    ...(batterSourceId ? { batterSourceId } : {}),
    ...(nonStriker ? { nonStriker } : {}),
    ...(nonStrikerSourceId ? { nonStrikerSourceId } : {}),
    ...(bowler ? { bowler } : {}),
    ...(bowlerSourceId ? { bowlerSourceId } : {}),
    batRuns,
    extraRuns,
    totalRuns,
    ...(explicitExtraType || inferredExtraType ? { extraType: explicitExtraType || inferredExtraType } : {}),
    extras,
    isWicket,
    ...(dismissalType ? { dismissalType } : {}),
    ...(dismissedPlayer ? { dismissedPlayer } : {}),
    ...(dismissedPlayerSourceId ? { dismissedPlayerSourceId } : {}),
    ...(fielder ? { fielder } : {}),
    ...(fielderSourceId ? { fielderSourceId } : {}),
    ...(description ? { description } : {}),
    ...(commentary ? { commentary } : {}),
    ...(eventType ? { eventType } : {}),
    rawData: record
  };
}

function normalizeCommentary(record: DataRecord, matchId: string): NormalizedCommentary | undefined {
  const commentary = commentaryText(record);
  if (!commentary) return undefined;
  const { over, ball } = parseOverBall(record);
  const inningsNumber = parseInningsNumber(record);
  const id = stringField(record, ["sourceEventId", "eventId", "commentaryId", "id", "key"]);
  const sourceTimestamp = scalar(record, ["timestamp", "timeStamp", "commentaryTimestamp", "sourceTimestamp"]);
  const signature = [matchId, inningsNumber, over ?? "", ball ?? "", sourceTimestamp ?? "", commentary].join("|");
  const eventType = stringField(record, ["eventType", "event", "type", "kind"]);
  const batter = stringField(record, ["batter", "batsman", "striker"]) ??
    nestedString(record, ["batsmanStriker"], ["batName", "batsmanName", "playerName", "name"]);
  const nonStriker = stringField(record, ["nonStriker", "nonStrikerName", "batsmanNonStriker"]) ??
    nestedString(record, ["batsmanNonStriker", "nonStrikerDetails"], ["batName", "batsmanName", "playerName", "name"]);
  const bowler = stringField(record, ["bowler", "bowlerName"]) ??
    nestedString(record, ["bowlerStriker"], ["bowlName", "bowlerName", "playerName", "name"]);
  const batterSourceId = structuredPlayerId(record, ["batterId", "batId", "batsmanId", "strikerId"]) ??
    nestedPlayerId(record, ["batsmanStriker"], ["batId", "batsmanId", "playerId", "id"]);
  const nonStrikerSourceId = structuredPlayerId(record, ["nonStrikerId", "nonStrikerPlayerId"]) ??
    nestedPlayerId(record, ["batsmanNonStriker", "nonStrikerDetails"], ["batId", "batsmanId", "playerId", "id"]);
  const bowlerSourceId = structuredPlayerId(record, ["bowlerId", "bowlId", "bowlerPlayerId"]) ??
    nestedPlayerId(record, ["bowlerStriker"], ["bowlId", "bowlerId", "playerId", "id"]);
  return {
    sourceEventId: id || matchId + ":commentary:" + stableHash(signature),
    inningsNumber,
    ...(over !== undefined ? { overNumber: over } : {}),
    ...(ball !== undefined ? { ballNumber: ball } : {}),
    ...(eventType ? { eventType } : {}),
    ...(batter ? { batter } : {}),
    ...(batterSourceId ? { batterSourceId } : {}),
    ...(nonStriker ? { nonStriker } : {}),
    ...(nonStrikerSourceId ? { nonStrikerSourceId } : {}),
    ...(bowler ? { bowler } : {}),
    ...(bowlerSourceId ? { bowlerSourceId } : {}),
    ...(sourceTimestamp !== undefined ? { sourceTimestamp: asString(sourceTimestamp) } : {}),
    ...(descriptionText(record) ? { description: descriptionText(record) } : {}),
    commentary,
    rawData: record
  };
}

function collectCricbuzzCommentaryRecords(
  root: unknown,
  inheritedInnings?: number,
  depth = 0,
  seen = new Set<object>(),
  output: DataRecord[] = []
): DataRecord[] {
  if (depth > 40 || !root || typeof root !== "object" || seen.has(root as object)) return output;
  seen.add(root as object);
  if (Array.isArray(root)) {
    for (const child of root) collectCricbuzzCommentaryRecords(child, inheritedInnings, depth + 1, seen, output);
    return output;
  }
  const record = root as DataRecord;
  const rawInnings = scalar(record, ["inningsNumber", "inningsNo", "inningNumber", "inningsId", "inningId"]);
  const currentInnings = rawInnings !== undefined ? parseInningsNumber({ inningsId: rawInnings }) : inheritedInnings;
  if (scalar(record, ["commText", "commentary", "comment", "commentaryText", "text"]) !== undefined) {
    output.push({
      ...record,
      ...(rawInnings === undefined && currentInnings !== undefined ? { inningsId: currentInnings } : {})
    });
  }
  for (const child of Object.values(record)) {
    collectCricbuzzCommentaryRecords(child, currentInnings, depth + 1, seen, output);
  }
  return output;
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
    const ball = node.attr("data-ball") ?? node.attr("data-ball-number");
    const innings = Number(node.attr("data-innings") ?? node.attr("data-innings-number") ?? 1);
    const readNumber = (...names: string[]) => {
      for (const name of names) {
        const value = node.attr("data-" + name);
        if (value !== undefined && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
      }
      return undefined;
    };
    const extras: DataRecord = {
      byes: readNumber("byes", "bye-runs"),
      legByes: readNumber("leg-byes", "legbyes", "leg-bye-runs"),
      wides: readNumber("wides", "wide-runs"),
      noBalls: readNumber("no-balls", "noballs", "no-ball-runs"),
      penalty: readNumber("penalty", "penalty-runs")
    };
    const record: DataRecord = {
      id: node.attr("data-event-id") ?? node.attr("data-commentary-id"),
      over,
      ball,
      inningsNumber: Number.isFinite(innings) && innings >= 0 ? innings : 1,
      batter: node.attr("data-batter") ?? node.attr("data-striker"),
      batterId: node.attr("data-batter-id") ?? node.attr("data-striker-id"),
      nonStriker: node.attr("data-non-striker"),
      nonStrikerId: node.attr("data-non-striker-id"),
      bowler: node.attr("data-bowler"),
      bowlerId: node.attr("data-bowler-id"),
      batRuns: readNumber("bat-runs", "batter-runs", "runs-off-bat"),
      extraRuns: readNumber("extra-runs", "extras-runs"),
      totalRuns: readNumber("total-runs", "delivery-runs"),
      extras,
      eventType: node.attr("data-event-type") ?? node.attr("data-event"),
      isWicket: node.attr("data-is-wicket") ?? node.attr("data-wicket"),
      dismissedPlayer: node.attr("data-dismissed-player") ?? node.attr("data-player-out"),
      dismissedPlayerId: node.attr("data-dismissed-player-id") ?? node.attr("data-player-out-id"),
      fielder: node.attr("data-fielder") ?? node.attr("data-fielder-name"),
      fielderId: node.attr("data-fielder-id"),
      dismissalType: node.attr("data-dismissal-type") ?? node.attr("data-wicket-type"),
      description: node.attr("data-description"),
      commentary: text,
      timestamp: node.attr("data-timestamp") ?? node.attr("data-time")
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
        ...(numberField(bowler, ["noBalls", "noballs", "nb", "no_balls"]) !== undefined ? { noBalls: numberField(bowler, ["noBalls", "noballs", "nb", "no_balls"]) } : {}),
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
        partnershipNumber: numberField(partnership, ["wicketNumber", "partnershipNumber", "number", "wktNbr"]) ?? inning.partnerships.length + 1,
        ...(batterOne ? { batterOne } : {}),
        ...(structuredPlayerId(partnership, ["bat1Id", "batterOneId", "playerOneId", "batsman1Id"]) ? {
          batterOneSourceId: structuredPlayerId(partnership, ["bat1Id", "batterOneId", "playerOneId", "batsman1Id"])
        } : {}),
        ...(numberField(partnership, ["bat1Runs", "batterOneRuns", "playerOneRuns"]) !== undefined ? {
          batterOneRuns: numberField(partnership, ["bat1Runs", "batterOneRuns", "playerOneRuns"])
        } : {}),
        ...(numberField(partnership, ["bat1Balls", "batterOneBalls", "playerOneBalls"]) !== undefined ? {
          batterOneBalls: numberField(partnership, ["bat1Balls", "batterOneBalls", "playerOneBalls"])
        } : {}),
        ...(batterTwo ? { batterTwo } : {}),
        ...(structuredPlayerId(partnership, ["bat2Id", "batterTwoId", "playerTwoId", "batsman2Id"]) ? {
          batterTwoSourceId: structuredPlayerId(partnership, ["bat2Id", "batterTwoId", "playerTwoId", "batsman2Id"])
        } : {}),
        ...(numberField(partnership, ["bat2Runs", "batterTwoRuns", "playerTwoRuns"]) !== undefined ? {
          batterTwoRuns: numberField(partnership, ["bat2Runs", "batterTwoRuns", "playerTwoRuns"])
        } : {}),
        ...(numberField(partnership, ["bat2Balls", "batterTwoBalls", "playerTwoBalls"]) !== undefined ? {
          batterTwoBalls: numberField(partnership, ["bat2Balls", "batterTwoBalls", "playerTwoBalls"])
        } : {}),
        runs: runsValue,
        ...(numberField(partnership, ["totalBalls", "balls", "ballsFaced"]) !== undefined ? {
          balls: numberField(partnership, ["totalBalls", "balls", "ballsFaced"])
        } : {}),
        ...(descriptionText(partnership) ? { description: descriptionText(partnership) } : {})
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
      const fielder = stringField(wicket, ["fielder", "fielderName", "catcher"]) ??
        nestedString(wicket, ["fielderDetails", "fieldersInvolved"], ["name", "playerName", "fieldingName"]);
      const row: NormalizedFallOfWicket = {
        wicketNumber,
        ...(scoreValue !== undefined ? { score: scoreValue } : {}),
        ...(batterName ? { batterName } : {}),
        ...(structuredPlayerId(wicket, ["batId", "batterId", "playerOutId"]) ? {
          playerSourceId: structuredPlayerId(wicket, ["batId", "batterId", "playerOutId"])
        } : {}),
        ...(stringField(wicket, ["wicketType", "dismissalType", "howOut"]) ? {
          dismissalType: stringField(wicket, ["wicketType", "dismissalType", "howOut"])
        } : {}),
        ...(fielder ? { fielder } : {}),
        ...(nestedPlayerId(wicket, ["fielderDetails", "fieldersInvolved"], ["id", "playerId", "fielderId"]) ? {
          fielderSourceId: nestedPlayerId(wicket, ["fielderDetails", "fieldersInvolved"], ["id", "playerId", "fielderId"])
        } : {}),
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
  const deliveries = new Map<string, NormalizedDelivery>();
  const commentary = new Map<string, NormalizedCommentary>();
  // Cricbuzz serves comment lines inside matchPreviewFullComm.commentary[].commentaryList[].
  // Parent inningsId is inherited for each child ball/commentary record.
  const commentaryRecords = collectCricbuzzCommentaryRecords(serverComponents);
  for (const record of commentaryRecords) {
    const delivery = normalizeStructuredDelivery(record, matchId);
    if (delivery) deliveries.set(delivery.sourceEventId, delivery);
    const comment = normalizeCommentary(record, matchId);
    if (comment) commentary.set(comment.sourceEventId, comment);
  }
  if (commentaryPage) {
    const html = parseHtmlCommentary(commentaryPage, matchId);
    for (const item of html.deliveries) if (!deliveries.has(item.sourceEventId)) deliveries.set(item.sourceEventId, item);
    for (const item of html.commentary) if (!commentary.has(item.sourceEventId)) commentary.set(item.sourceEventId, item);
  }
  const innings = [...inningsMap.values()].sort((a, b) => a.inningsNumber - b.inningsNumber);
  for (const inning of innings) {
    inning.batters = [...new Map(inning.batters.map(row => [
      row.playerSourceId ? "id:" + row.playerSourceId : "name:" + row.playerName.toLowerCase(),
      row
    ] as const)).values()];
    inning.bowlers = [...new Map(inning.bowlers.map(row => [
      row.playerSourceId ? "id:" + row.playerSourceId : "name:" + row.playerName.toLowerCase(),
      row
    ] as const)).values()];
    inning.partnerships = [...new Map(inning.partnerships.map(row => [row.partnershipNumber, row] as const)).values()]
      .sort((a, b) => a.partnershipNumber - b.partnershipNumber);
    inning.fallOfWickets = [...new Map(inning.fallOfWickets.map(row => [row.wicketNumber, row] as const)).values()]
      .sort((a, b) => a.wicketNumber - b.wicketNumber);
  }
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
