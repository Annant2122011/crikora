import { createHash, createHmac } from "node:crypto";

export interface ArchiveObjectStore {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

export interface NeonS3ArchiveOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetcher?: typeof fetch;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodedPath(bucket: string, key: string): string {
  return `/${awsEncode(bucket)}/${key.split("/").map(awsEncode).join("/")}`;
}

export function buildNeonS3Authorization(input: {
  method: "GET" | "PUT";
  endpoint: URL;
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
  payloadHash: string;
  contentType: string;
}): { authorization: string; amzDate: string; dateStamp: string } {
  const amzDate = input.date.toISOString().replace(/[:-]|\\.\\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = [
    `content-type:${input.contentType.trim()}\n`,
    `host:${input.endpoint.host}\n`,
    `x-amz-content-sha256:${input.payloadHash}\n`,
    `x-amz-date:${amzDate}\n`
  ].join("");
  const canonicalRequest = [
    input.method,
    input.path,
    "",
    canonicalHeaders,
    signedHeaders,
    input.payloadHash
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest)
  ].join("\n");
  const dateKey = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    dateStamp
  };
}

/**
 * Minimal AWS Signature V4 client for Neon Object Storage.
 * Neon requires path-style addressing and a branch-scoped storage credential.
 */
export class NeonS3ArchiveObjectStore implements ArchiveObjectStore {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: NeonS3ArchiveOptions) {
    this.endpoint = new URL(options.endpoint);
    if (this.endpoint.protocol !== "https:") throw new Error("Archive object storage endpoint must use HTTPS.");
    if (!options.bucket.trim() || !options.region.trim() || !options.accessKeyId.trim() || !options.secretAccessKey.trim()) {
      throw new Error("Neon archive object storage configuration is incomplete.");
    }
    this.fetcher = options.fetcher ?? fetch;
  }

  async put(key: string, body: Uint8Array, contentType = "application/gzip"): Promise<void> {
    await this.request("PUT", key, body, contentType);
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.request("GET", key, undefined, "application/octet-stream");
    return new Uint8Array(await response.arrayBuffer());
  }

  private async request(
    method: "GET" | "PUT",
    key: string,
    body: Uint8Array | undefined,
    contentType: string
  ): Promise<Response> {
    if (!key || key.startsWith("/") || key.split("/").some(part => part === ".." || part === ".")) {
      throw new Error("Archive object key must be a relative, normalized key.");
    }
    const path = encodedPath(this.options.bucket, key);
    const target = new URL(path, this.endpoint.origin);
    const payload = body ?? new Uint8Array();
    const payloadHash = sha256(payload);
    const signed = buildNeonS3Authorization({
      method,
      endpoint: this.endpoint,
      path,
      region: this.options.region,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      date: new Date(),
      payloadHash,
      contentType
    });
    const headers: Record<string, string> = {
      authorization: signed.authorization,
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": signed.amzDate
    };
    const response = await this.fetcher(target.toString(), {
      method,
      headers,
      ...(method === "PUT" ? { body: Buffer.from(payload) } : {})
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 800);
      throw new Error(`Neon archive object storage returned HTTP ${response.status} for ${method} ${key}: ${detail}`);
    }
    return response;
  }
}

export function createArchiveObjectStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ArchiveObjectStore | undefined {
  const endpoint = env.AWS_ENDPOINT_URL_S3?.trim();
  const region = env.AWS_REGION?.trim();
  const bucket = env.CRIKORA_ARCHIVE_BUCKET?.trim();
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  const values = [endpoint, region, bucket, accessKeyId, secretAccessKey];
  if (values.every(value => !value)) return undefined;
  if (values.some(value => !value)) {
    throw new Error(
      "Neon archive storage requires AWS_ENDPOINT_URL_S3, AWS_REGION, CRIKORA_ARCHIVE_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY."
    );
  }
  return new NeonS3ArchiveObjectStore({
    endpoint: endpoint!,
    region: region!,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!
  });
}
