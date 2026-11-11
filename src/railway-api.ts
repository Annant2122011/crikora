import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import handler from "../api/[...path].js";
import { createArchiveObjectStoreFromEnv } from "./storage/neon-s3-archive-object-store.js";

async function verifyArchiveStorageOnStartup(): Promise<void> {
  if (process.env.CRIKORA_VERIFY_ARCHIVE_STORAGE_ON_START !== "true") return;
  const store = createArchiveObjectStoreFromEnv(process.env);
  if (!store) throw new Error("Archive-storage startup check requested, but Neon Object Storage is not configured.");
  const payload = Buffer.from(JSON.stringify({
    service: "crikora-api",
    purpose: "startup-storage-roundtrip",
    id: randomUUID(),
    createdAt: new Date().toISOString()
  }), "utf8");
  const key = `diagnostics/roundtrip/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const expectedHash = createHash("sha256").update(payload).digest("hex");
  await store.put(key, payload, "application/json");
  const downloaded = Buffer.from(await store.get(key));
  const actualHash = createHash("sha256").update(downloaded).digest("hex");
  if (downloaded.length !== payload.length || actualHash !== expectedHash) {
    throw new Error("Neon Object Storage startup round-trip verification failed.");
  }
  console.info("CRIKORA_ARCHIVE_STORAGE_VERIFIED", JSON.stringify({
    bucket: process.env.CRIKORA_ARCHIVE_BUCKET,
    objectKey: key,
    bytes: payload.length,
    sha256: expectedHash,
    verified: "PUT then GET byte-for-byte"
  }));
}

await verifyArchiveStorageOnStartup();

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8787);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new RangeError("PORT must be an integer between 1 and 65535.");
}

const server = createServer((request, response) => {
  void handler(request, response).catch(error => {
    console.error("Crikora Railway API request failed", error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ error: "Internal server error." }));
    } else {
      response.end();
    }
  });
});

server.requestTimeout = 75_000;
server.headersTimeout = 80_000;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  console.info(`Crikora Railway API listening on http://${host}:${port}`);
});

const shutdown = (signal: string) => {
  console.info(`Received ${signal}; closing the Crikora API listener.`);
  server.close(error => {
    if (error) {
      console.error("Crikora API shutdown failed", error);
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
