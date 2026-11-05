import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { z } from "zod";
import { DemoProvider } from "./providers/demo-provider.js";
import { CricbuzzProvider } from "./providers/cricbuzz-provider.js";
import { MemoryRepository } from "./storage/repository.js";
import { Poller } from "./ingestion/poller.js";

const env = z.object({
  HOST: z.string().default("0.0.0.0"), PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.string().default("info"), POLL_INTERVAL_MS: z.coerce.number().int().min(30000).default(90000),
  SOURCE_MODE: z.enum(["demo", "cricbuzz"]).default("demo"), CRICKET_SOURCE_ENABLED: z.string().default("false"),
  CRICBUZZ_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  CRICBUZZ_MAX_MATCHES_PER_POLL: z.coerce.number().int().min(1).max(50).default(20),
  CRICBUZZ_TIMEOUT_MS: z.coerce.number().int().min(3000).max(60000).default(15000),
  CRICBUZZ_USER_AGENT: z.string().default("Crikora/0.1 (+https://github.com/Annant2122011/crikora; authorized data access)")
}).parse(process.env);

if (env.SOURCE_MODE === "cricbuzz" && env.CRICKET_SOURCE_ENABLED !== "true") throw new Error("Set CRICKET_SOURCE_ENABLED=true to enable the Cricbuzz collector.");
if (env.SOURCE_MODE === "demo" && env.CRICKET_SOURCE_ENABLED === "true") throw new Error("Choose SOURCE_MODE=cricbuzz when enabling the Cricbuzz collector.");

const app = Fastify({ logger: { level: env.LOG_LEVEL }, requestIdHeader: "x-request-id" });
const repository = new MemoryRepository();
const provider = env.SOURCE_MODE === "cricbuzz"
  ? new CricbuzzProvider({ minRequestIntervalMs: env.CRICBUZZ_MIN_REQUEST_INTERVAL_MS, maxMatchesPerPoll: env.CRICBUZZ_MAX_MATCHES_PER_POLL, timeoutMs: env.CRICBUZZ_TIMEOUT_MS, userAgent: env.CRICBUZZ_USER_AGENT })
  : new DemoProvider();
const poller = new Poller(provider, repository, env.POLL_INTERVAL_MS);

await app.register(helmet);
await app.register(cors, { origin: false });
app.get("/health", async () => ({ ok: true, service: "crikora-api", source: provider.id }));
app.get("/v1/matches", async (request, reply) => {
  const parsed = z.object({ status: z.enum(["live","upcoming","completed"]).optional() }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid status filter" });
  return { data: await repository.listMatches(parsed.data.status) };
});
app.get("/v1/matches/live", async () => ({ data: await repository.listMatches("live") }));
app.get("/v1/matches/:matchId", async (request, reply) => {
  const { matchId } = request.params as { matchId: string };
  const match = await repository.getMatch(matchId);
  if (!match) return reply.code(404).send({ error: "Match not found" });
  return { data: match };
});
app.get("/v1/matches/:matchId/events", async (request, reply) => {
  const { matchId } = request.params as { matchId: string };
  if (!await repository.getMatch(matchId)) return reply.code(404).send({ error: "Match not found" });
  return { data: await repository.listEvents(matchId) };
});
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send({ error: "Internal server error" });
});

await poller.tick();
poller.start();
const close = async () => { poller.stop(); await app.close(); };
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
await app.listen({ host: env.HOST, port: env.PORT });
