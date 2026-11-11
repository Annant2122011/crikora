import { randomUUID, createHash } from "node:crypto";
import "dotenv/config";
import { createArchiveObjectStoreFromEnv } from "./neon-s3-archive-object-store.js";

async function main(): Promise<void> {
  const store = createArchiveObjectStoreFromEnv(process.env);
  if (!store) {
    throw new Error("Neon archive storage is not configured. Set all five AWS/CRIKORA archive variables in the core API environment.");
  }

  const bucket = process.env.CRIKORA_ARCHIVE_BUCKET?.trim();
  if (!bucket) throw new Error("CRIKORA_ARCHIVE_BUCKET is missing.");

  const payload = Buffer.from(
    JSON.stringify({ service: "crikora", purpose: "object-storage-roundtrip", id: randomUUID(), createdAt: new Date().toISOString() }),
    "utf8"
  );
  const key = `diagnostics/roundtrip/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const expectedHash = createHash("sha256").update(payload).digest("hex");

  await store.put(key, payload, "application/json");
  const downloaded = Buffer.from(await store.get(key));
  const actualHash = createHash("sha256").update(downloaded).digest("hex");

  if (downloaded.length !== payload.length || actualHash !== expectedHash) {
    throw new Error("Neon Object Storage round-trip verification failed: downloaded bytes differ from the uploaded payload.");
  }

  console.log(JSON.stringify({
    ok: true,
    bucket,
    objectKey: key,
    bytes: payload.length,
    sha256: expectedHash,
    verified: "PUT then GET byte-for-byte"
  }, null, 2));
}

main().catch(error => {
  console.error("Crikora archive storage verification failed:", error);
  process.exitCode = 1;
});
