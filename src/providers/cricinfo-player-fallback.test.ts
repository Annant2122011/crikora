import { describe, expect, it, vi } from "vitest";
import { CricinfoPlayerFallback } from "./cricinfo-player-fallback.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("ESPNcricinfo player fallback extractor", () => {
  it("resolves both-gender team indexes, preserves the complete profile payload and normalizes photo URLs", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl);
      if (url.pathname === "/v1/pages/team") {
        return jsonResponse({
          content: {
            featuredTeamsGroups: {
              groups: [{
                title: "POPULAR WOMEN'S INTERNATIONAL TEAMS",
                teams: [{ objectId: 102, longName: "India Women", abbreviation: "IND-W" }]
              }]
            }
          }
        });
      }
      if (url.pathname === "/v1/pages/player/search") {
        expect(url.searchParams.get("mode")).toBe("BOTH");
        expect(url.searchParams.get("filterTeamId")).toBe("102");
        expect(url.searchParams.get("filterActive")).toBe("false");
        return jsonResponse({
          total: 1,
          results: [{
            objectId: 597806,
            slug: "smriti-mandhana",
            longName: "Smriti Mandhana",
            gender: "FEMALE"
          }]
        });
      }
      if (url.pathname === "/v1/pages/player/home") {
        expect(url.searchParams.get("playerId")).toBe("597806");
        return jsonResponse({
          player: {
            objectId: 597806,
            slug: "smriti-mandhana",
            longName: "Smriti Mandhana",
            gender: "FEMALE",
            imageUrl: "/db/PICTURES/CMS/123456/123456.png",
            headshotImage: { url: "/db/PICTURES/CMS/654321/654321.png" },
            dateOfBirth: "1996-07-18",
            countryTeamId: 102
          },
          content: {
            careerAverages: {
              stats: [{ type: "ODI", matches: 100, runs: 4000 }]
            },
            additionalProfileData: { handedness: "Left hand bat" }
          }
        });
      }
      throw new Error(`Unexpected ESPNcricinfo request: ${url.toString()}`);
    });

    const fallback = new CricinfoPlayerFallback({
      fetcher,
      minRequestIntervalMs: 0
    });
    const result = await fallback.lookup({
      fullName: "Smriti Mandhana",
      country: "India",
      gender: "Female"
    });

    expect(result).toMatchObject({
      playerId: "597806",
      fullName: "Smriti Mandhana",
      profileUrl: "https://www.espncricinfo.com/cricketers/smriti-mandhana-597806",
      imageUrl: "https://img1.hscicdn.com/image/upload/lsci/db/PICTURES/CMS/123456/123456.png",
      headshotImageUrl: "https://img1.hscicdn.com/image/upload/lsci/db/PICTURES/CMS/654321/654321.png"
    });
    expect(result?.sourceData).toMatchObject({
      playerHome: {
        content: {
          careerAverages: {
            stats: [{ type: "ODI", matches: 100, runs: 4000 }]
          }
        }
      }
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not query Cricinfo when the Crikora profile has no country to disambiguate the player", async () => {
    const fetcher = vi.fn();
    const fallback = new CricinfoPlayerFallback({
      fetcher: fetcher as unknown as typeof fetch,
      minRequestIntervalMs: 0
    });

    await expect(fallback.lookup({ fullName: "A Player" })).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not attach an ambiguous same-name result across men's and women's teams", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl);
      if (url.pathname === "/v1/pages/team") {
        return jsonResponse({
          content: {
            featuredTeamsGroups: {
              groups: [
                { title: "MEN'S INTERNATIONAL TEAMS", teams: [{ objectId: 1, longName: "India" }] },
                { title: "WOMEN'S INTERNATIONAL TEAMS", teams: [{ objectId: 2, longName: "India Women" }] }
              ]
            }
          }
        });
      }
      if (url.pathname === "/v1/pages/player/search") {
        const id = url.searchParams.get("filterTeamId");
        return jsonResponse({
          total: 1,
          results: [{
            objectId: id === "1" ? 101 : 201,
            slug: "alex-example",
            longName: "Alex Example",
            gender: id === "1" ? "MALE" : "FEMALE"
          }]
        });
      }
      throw new Error(`Unexpected ESPNcricinfo request: ${url.toString()}`);
    });
    const fallback = new CricinfoPlayerFallback({ fetcher, minRequestIntervalMs: 0 });

    await expect(fallback.lookup({
      fullName: "Alex Example",
      country: "India"
    })).resolves.toBeUndefined();
  });
});
