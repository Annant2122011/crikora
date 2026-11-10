import { describe, expect, it, vi } from "vitest";
import {
  buildNeonS3Authorization,
  createArchiveObjectStoreFromEnv,
  NeonS3ArchiveObjectStore
} from "./neon-s3-archive-object-store.js";

const endpoint = new URL("https://br-cold-bird-bdw51znf.storage.c-8.us-east-2.aws.neon.tech");

describe("Neon S3 archive object storage", () => {
  it("builds a stable SigV4 authorization header and UTC timestamp", () => {
    const signed = buildNeonS3Authorization({
      method: "GET",
      endpoint,
      path: "/crikora-raw-archive/pages/example.html.gz",
      region: "us-east-2",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      date: new Date("2026-11-10T12:13:14.321Z"),
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      contentType: "application/octet-stream"
    });
    expect(signed.amzDate).toBe("20261110T121314Z");
    expect(signed.dateStamp).toBe("20261110");
    expect(signed.authorization).toContain("Credential=test-access-key/20261110/us-east-2/s3/aws4_request");
    expect(signed.authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(signed.authorization).toMatch(/Signature=[a-f0-9]{64}$/);
  });

  it("uploads to a path-style private bucket using an ArrayBuffer-backed body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const store = new NeonS3ArchiveObjectStore({
      endpoint: endpoint.toString(),
      region: "us-east-2",
      bucket: "crikora-raw-archive",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      fetcher
    });
    await store.put("pages/sha256/ab/example.html.gz", Buffer.from("archive"));
    expect(fetcher).toHaveBeenCalledOnce();
    const [target, init] = fetcher.mock.calls[0]!;
    expect(String(target)).toBe(
      "https://br-cold-bird-bdw51znf.storage.c-8.us-east-2.aws.neon.tech/crikora-raw-archive/pages/sha256/ab/example.html.gz"
    );
    expect(init?.method).toBe("PUT");
    expect(Buffer.from(init?.body as ArrayBuffer).toString()).toBe("archive");
    expect(init?.headers).toMatchObject({
      "content-type": "application/gzip",
      "x-amz-content-sha256": expect.any(String),
      "x-amz-date": expect.any(String)
    });
  });

  it("downloads the object bytes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("archived-html"));
    const store = new NeonS3ArchiveObjectStore({
      endpoint: endpoint.toString(),
      region: "us-east-2",
      bucket: "crikora-raw-archive",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      fetcher
    });
    const bytes = await store.get("pages/sha256/ab/example.html.gz");
    expect(Buffer.from(bytes).toString()).toBe("archived-html");
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("rejects object keys that could escape the bucket prefix", async () => {
    const store = new NeonS3ArchiveObjectStore({
      endpoint: endpoint.toString(),
      region: "us-east-2",
      bucket: "crikora-raw-archive",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      fetcher: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    });
    await expect(store.get("../outside")).rejects.toThrow("relative, normalized key");
  });

  it("only enables the object store when every required environment value is present", () => {
    expect(createArchiveObjectStoreFromEnv({})).toBeUndefined();
    expect(() => createArchiveObjectStoreFromEnv({
      AWS_ENDPOINT_URL_S3: endpoint.toString()
    } as NodeJS.ProcessEnv)).toThrow("requires AWS_ENDPOINT_URL_S3");
    expect(createArchiveObjectStoreFromEnv({
      AWS_ENDPOINT_URL_S3: endpoint.toString(),
      AWS_REGION: "us-east-2",
      CRIKORA_ARCHIVE_BUCKET: "crikora-raw-archive",
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key"
    } as NodeJS.ProcessEnv)).toBeInstanceOf(NeonS3ArchiveObjectStore);
  });
});
