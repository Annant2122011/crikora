import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CricbuzzProvider } from "../providers/cricbuzz-provider.js";

interface SavedInventory {
  urls?: Array<string | { url?: string }>;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(name + " must be a non-negative integer.");
  }
  return value;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function routeFamily(value: string): string {
  const path = new URL(value).pathname;
  return "/" + (path.split("/").filter(Boolean)[0] ?? "");
}

function samplesByFamily(urls: string[], maximum = 3): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const url of urls) {
    const family = routeFamily(url);
    const samples = result[family] ?? (result[family] = []);
    if (samples.length < maximum) samples.push(url);
  }
  return result;
}

function printHelp(): void {
  console.log([
    "Crikora live sitemap coverage audit",
    "",
    "Run: npm run sitemap:audit",
    "Full URL inventory: npm run sitemap:audit -- --full",
    "No Neon connection or API secrets are required.",
    "",
    "Optional environment:",
    "  CRICBUZZ_MIN_REQUEST_INTERVAL_MS=1000",
    "  CRICBUZZ_TIMEOUT_MS=15000",
    "  CRICBUZZ_MAX_RESPONSE_BYTES=8000000",
    "  CRIKORA_SITEMAP_AUDIT_TIMEOUT_MS=120000"
  ].join("\n"));
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    printHelp();
    return;
  }

  const inventoryPath = resolve(process.cwd(), "docs", "cricbuzz-sitemap-inventory.json");
  const saved = JSON.parse(readFileSync(inventoryPath, "utf8")) as SavedInventory;
  if (!Array.isArray(saved.urls)) {
    throw new Error("The saved Cricbuzz inventory does not contain a URL array.");
  }

  const savedUrls = saved.urls
    .map(item => typeof item === "string" ? item : item.url ?? "")
    .filter(Boolean)
    .map(normalizeUrl);
  const savedSet = new Set(savedUrls);

  const provider = new CricbuzzProvider({
    minRequestIntervalMs: numberEnv("CRICBUZZ_MIN_REQUEST_INTERVAL_MS", 1_000),
    maxMatchesPerPoll: 1,
    maxProfilesPerPoll: 1,
    maxTeamsPerPoll: 1,
    maxSeriesPerPoll: 1,
    maxVenuesPerPoll: 1,
    maxContentPagesPerPoll: 0,
    timeoutMs: numberEnv("CRICBUZZ_TIMEOUT_MS", 15_000),
    maxResponseBytes: numberEnv("CRICBUZZ_MAX_RESPONSE_BYTES", 8_000_000),
    userAgent: process.env.CRICBUZZ_USER_AGENT ??
      "Crikora/0.1 (+https://github.com/Annant2122011/crikora)"
  });

  const timeoutMs = numberEnv("CRIKORA_SITEMAP_AUDIT_TIMEOUT_MS", 120_000);
  const discovered = await provider.discoverSitemapUrls(AbortSignal.timeout(timeoutMs));
  const liveUrls = discovered.pageUrls.map(normalizeUrl);
  const liveSet = new Set(liveUrls);
  const newUrls = [...liveSet].filter(url => !savedSet.has(url));
  const snapshotOnlyUrls = [...savedSet].filter(url => !liveSet.has(url));
  const mergedUrls = [...new Set([...savedSet, ...liveSet])];

  const routeCounts: Record<string, number> = {};
  for (const url of liveSet) {
    const family = routeFamily(url);
    routeCounts[family] = (routeCounts[family] ?? 0) + 1;
  }

  const report: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "https://www.cricbuzz.com",
    discoveryMethod: "recursive fetch of the public sitemap tree",
    savedSnapshotUrlCount: savedSet.size,
    liveSitemapDocumentCount: discovered.sitemapUrls.length,
    liveSitemapDocuments: discovered.sitemapUrls,
    liveSitemapPageUrlCount: liveSet.size,
    newSinceSavedSnapshotCount: newUrls.length,
    savedSnapshotNotInCurrentSitemapCount: snapshotOnlyUrls.length,
    mergedSeedUrlCount: mergedUrls.length,
    routeFamilyCounts: Object.fromEntries(
      Object.entries(routeCounts).sort(([left], [right]) => left.localeCompare(right))
    ),
    routeFamilySamples: samplesByFamily([...liveSet])
  };

  if (args.has("--full")) {
    report.liveSitemapPageUrls = [...liveSet].sort();
    report.newSinceSavedSnapshotUrls = newUrls.sort();
    report.savedSnapshotNotInCurrentSitemapUrls = snapshotOnlyUrls.sort();
    report.mergedSeedUrls = mergedUrls.sort();
  }

  console.log(JSON.stringify(report, null, 2));
}

void main().catch(error => {
  console.error("Crikora sitemap audit failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
