import { describe, expect, it, vi } from "vitest";
import { CrikoraApiClient, CrikoraApiError } from "./crikora-api-client.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("CrikoraApiClient", () => {
  it("validates the API origin and rejects embedded credentials", () => {
    expect(() => new CrikoraApiClient("not-a-url")).toThrow(TypeError);
    expect(() => new CrikoraApiClient("ftp://crikora.example")).toThrow(TypeError);
    expect(() => new CrikoraApiClient("https://user:pass@crikora.example")).toThrow(TypeError);
  });

  it("requests the live JSON feed with bounded query parameters", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      data: [{ id: "123", status: "live" }],
      meta: { count: 1, retentionSeconds: 600 }
    })) as unknown as typeof fetch;
    const client = new CrikoraApiClient("https://api.crikora.example/", fetcher);

    const response = await client.listLiveMatches(50);

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.crikora.example/v1/matches?status=live&limit=50",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" }
      })
    );
    expect(response.data[0]?.id).toBe("123");
    expect(response.meta?.retentionSeconds).toBe(600);
  });

  it("normalizes Cricbuzz-prefixed match IDs and URL-encodes them", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { id: "123" } })) as unknown as typeof fetch;
    const client = new CrikoraApiClient("https://api.crikora.example", fetcher);

    await client.getMatch("cricbuzz:123/extra");

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.crikora.example/v1/matches/123%2Fextra",
      expect.any(Object)
    );
  });

  it("surfaces useful non-2xx API errors", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "Entity not found or expired" }, 404)) as unknown as typeof fetch;
    const client = new CrikoraApiClient("https://api.crikora.example", fetcher);

    await expect(client.getMatch("missing")).rejects.toMatchObject({
      name: "CrikoraApiError",
      status: 404,
      message: "Entity not found or expired"
    });
    await expect(client.getMatch("missing")).rejects.toBeInstanceOf(CrikoraApiError);
  });
});
