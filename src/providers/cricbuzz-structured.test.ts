import { describe, expect, it } from "vitest";
import { load } from "cheerio";
import { normalizeCricbuzzPlayerProfile, parseCricbuzzMatchData } from "./cricbuzz-structured.js";

describe("typed Crikora player profile extraction", () => {
  it("normalizes labelled fields, typed profile attributes, biography and statistical tables", () => {
    const $ = load(`
      <html><main><h1>Example Player</h1>
        <dl><dt>Born</dt><dd>22 May 1998</dd><dt>Birth Place</dt><dd>Durban, South Africa</dd></dl>
        <table><tr><th>Role</th><td>All-rounder</td></tr><tr><th>Batting Style</th><td>Right hand bat</td></tr></table>
        <h2>Biography</h2><p>Long-form player biography with career milestones.</p>
        <table><tr><th>Format</th><th>Matches</th><th>Runs</th></tr><tr><td>ODI</td><td>20</td><td>700</td></tr></table>
      </main></html>`);
    const profile = normalizeCricbuzzPlayerProfile($, "https://www.cricbuzz.com/profiles/123/example", {
      keyedData: { playerData: [{ fullName: "Example Player", country: "South Africa", role: "All-rounder",
        battingStyle: "Right hand bat", bowlingStyle: "Right arm medium", teams: ["Titans", "Dolphins"],
        height: "1.82 m", biography: "International career biography." }] }
    });
    expect(profile).toMatchObject({
      schemaVersion: 1,
      fullName: "Example Player",
      country: "South Africa",
      role: "All-rounder",
      battingStyle: "Right hand bat",
      bowlingStyle: "Right arm medium",
      birthDate: "1998-05-22",
      birthPlace: "Durban, South Africa",
      heightCm: 182,
      teams: ["Titans", "Dolphins"]
    });
    expect(profile.biography).toContain("Long-form player biography");
    expect(profile.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceLabel: "Born", valueType: "date" }),
      expect.objectContaining({ fieldPath: "battingStyle", value: "Right hand bat" })
    ]));
    expect(profile.statistics).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricKey: "matches", valueNumeric: 20 }),
      expect.objectContaining({ metricKey: "runs", valueNumeric: 700 })
    ]));
  });
});

describe("typed Crikora scorecard and ball-by-ball extraction", () => {
  it("normalizes innings, batter/bowler rows, extras, partnerships, dismissals and commentary from RSC", () => {
    const data = parseCricbuzzMatchData("456", undefined, undefined, {
      scorecard: {
        scorecardData: [{
          inningsNumber: 1,
          batTeamDetails: {
            batTeamName: "Team A", runs: 182, wickets: 6, overs: "20.0",
            batsmenData: {
              "1": { batId: 11, batName: "A Batter", batRuns: 71, balls: 42, fours: 8, sixes: 2, strikeRate: 169.04, isNotOut: false, outDesc: "c Keeper b Bowler" },
              "2": { batId: 12, batName: "B Batter", batRuns: 22, balls: 14, fours: 2, sixes: 1, isNotOut: true, outDesc: "not out" }
            }
          },
          bowlTeamDetails: {
            bowlersData: { "3": { bowlId: 13, bowlName: "Bowler", overs: "4.0", maidens: 0, runs: 31, wickets: 2, economy: 7.75, wides: 1, noBalls: 0 } }
          },
          extrasData: { total: 7, byes: 1, legByes: 2, wides: 3, noBalls: 1, penalty: 0 },
          partnershipsData: [{ partnershipNumber: 1, bat1Name: "A Batter", bat2Name: "B Batter", totalRuns: 48, totalBalls: 29 }],
          wicketsData: [{ wktNbr: 1, batName: "A Batter", wktRuns: 91, wktOver: "10.4", description: "Caught by Keeper" }]
        }]
      },
      commentary: {
        commentaryPageData: {
          commentaryList: [{
            eventId: "delivery-1", inningsNumber: 1, overNumber: 0, ballNumber: 1,
            batsmanStriker: "A Batter", batsmanNonStriker: "B Batter", bowler: "Bowler",
            batRuns: 4, totalRuns: 4, extras: { total: 0 }, eventType: "FOUR",
            commentary: "A Batter drives this through cover for four."
          }]
        }
      }
    });
    expect(data.innings).toHaveLength(1);
    expect(data.innings[0]).toMatchObject({
      teamName: "Team A", runs: 182, wickets: 6, overs: "20.0",
      extras: { total: 7, byes: 1, legByes: 2, wides: 3, noBalls: 1 },
      batters: [
        expect.objectContaining({ playerName: "A Batter", runs: 71, balls: 42, fours: 8, sixes: 2, notOut: false }),
        expect.objectContaining({ playerName: "B Batter", notOut: true })
      ],
      bowlers: [expect.objectContaining({ playerName: "Bowler", wickets: 2, economy: 7.75 })],
      partnerships: [expect.objectContaining({ batterOne: "A Batter", batterTwo: "B Batter", runs: 48, balls: 29 })],
      fallOfWickets: [expect.objectContaining({ wicketNumber: 1, batterName: "A Batter", over: "10.4" })]
    });
    expect(data.deliveries).toEqual([
      expect.objectContaining({
        sourceEventId: "delivery-1", inningsNumber: 1, overNumber: 0, ballNumber: 1,
        batter: "A Batter", nonStriker: "B Batter", bowler: "Bowler", batRuns: 4, totalRuns: 4
      })
    ]);
    expect(data.commentary).toEqual([
      expect.objectContaining({ sourceEventId: "delivery-1", commentary: "A Batter drives this through cover for four." })
    ]);
  });

  it("parses scorecard tables by header labels rather than fixed cell positions", () => {
    const scorecard = load(`
      <main><h2>1st Innings</h2>
        <table><thead><tr><th>Batter</th><th>Dismissal</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead>
          <tbody><tr><td>Table Batter</td><td>not out</td><td>35</td><td>20</td><td>4</td><td>1</td><td>175.00</td></tr></tbody>
        </table>
        <table><thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>NB</th><th>WD</th><th>ECON</th></tr></thead>
          <tbody><tr><td>Table Bowler</td><td>4</td><td>0</td><td>25</td><td>2</td><td>0</td><td>1</td><td>6.25</td></tr></tbody>
        </table>
      </main>`);
    const data = parseCricbuzzMatchData("789", scorecard, undefined);
    expect(data.innings[0]?.batters).toEqual([
      expect.objectContaining({ playerName: "Table Batter", runs: 35, balls: 20, fours: 4, sixes: 1, notOut: true })
    ]);
    expect(data.innings[0]?.bowlers).toEqual([
      expect.objectContaining({ playerName: "Table Bowler", overs: "4", wickets: 2, wides: 1 })
    ]);
  });
});


describe("Cricbuzz live React Server Component schema compatibility", () => {
  it("normalizes Cricbuzz scoreCard innings, totals, extras, batting, bowling, partnerships and wickets", () => {
    const data = parseCricbuzzMatchData("162823", undefined, undefined, {
      scorecard: {
        scorecardApiData: {
          scoreCard: [{
            matchId: 162823,
            inningsId: 2,
            batTeamDetails: {
              batTeamId: 355,
              batTeamName: "Adelaide Strikers Women",
              batTeamShortName: "ADSW",
              batsmenData: {
                bat_1: {
                  batId: 9653, batName: "Lizelle Lee", runs: 19, balls: 18,
                  fours: 4, sixes: 0, strikeRate: 105.56, outDesc: "lbw b Sophie Ecclestone",
                  wicketCode: "LBW"
                }
              }
            },
            bowlTeamDetails: {
              bowlTeamId: 357,
              bowlTeamName: "Hobart Hurricanes Women",
              bowlersData: {
                bowl_1: {
                  bowlerId: 38748, bowlName: "Eleanor Larosa", overs: 2,
                  maidens: 0, runs: 13, wickets: 0, economy: 6.5,
                  no_balls: 0, wides: 1
                }
              }
            },
            scoreDetails: { ballNbr: 120, overs: 20, runRate: 6.9, runs: 139, wickets: 6 },
            extrasData: { byes: 2, legByes: 3, noBalls: 0, penalty: 0, total: 14, wides: 9 },
            partnershipsData: {
              pat_1: { bat1Id: 9653, bat1Name: "Lizelle Lee", bat2Id: 9149,
                bat2Name: "Chamari Athapaththu", totalRuns: 21, totalBalls: 23 }
            },
            wicketsData: {
              wkt_1: { batId: 9653, batName: "Lizelle Lee", wktOver: 3.5, wktRuns: 21, ballNbr: 23, wktNbr: 1 }
            }
          }]
        }
      }
    });
    expect(data.innings).toHaveLength(1);
    expect(data.innings[0]).toMatchObject({
      inningsNumber: 2,
      teamName: "Adelaide Strikers Women",
      runs: 139,
      wickets: 6,
      overs: "20",
      extras: { total: 14, byes: 2, legByes: 3, noBalls: 0, wides: 9, penalty: 0 },
      batters: [expect.objectContaining({
        playerSourceId: "9653", playerName: "Lizelle Lee", runs: 19,
        balls: 18, fours: 4, strikeRate: 105.56, dismissal: "lbw b Sophie Ecclestone"
      })],
      bowlers: [expect.objectContaining({
        playerSourceId: "38748", playerName: "Eleanor Larosa",
        overs: "2", runs: 13, wickets: 0, economy: 6.5, wides: 1
      })],
      partnerships: [expect.objectContaining({
        partnershipNumber: 1, batterOne: "Lizelle Lee",
        batterTwo: "Chamari Athapaththu", runs: 21, balls: 23
      })],
      fallOfWickets: [expect.objectContaining({
        wicketNumber: 1, batterName: "Lizelle Lee", score: 21, over: "3.5"
      })]
    });
    expect(data.coverage.deliveryCompleteness).toBe("not-exposed");
  });

  it("inherits inningsId and parses nested striker/bowler objects and ballNbr without turning ballNbr zero notes into deliveries", () => {
    const data = parseCricbuzzMatchData("162823", undefined, undefined, {
      commentary: {
        matchPreviewFullComm: {
          matchId: 162823,
          commentary: [{
            inningsId: 0,
            commentaryList: [{
              commText: "B0$",
              timestamp: 1000,
              ballNbr: 0,
              event: "NONE",
              commentaryFormats: { bold: { formatId: ["B0$"], formatValue: ["Teams:"] } }
            }]
          }, {
            inningsId: 2,
            commentaryList: [{
              commText: "FOUR,OVER-BREAK",
              timestamp: 2000,
              ballNbr: 14,
              event: "FOUR,OVER-BREAK",
              batTeamName: "ADSW",
              batsmanStriker: { batId: 9653, batName: "Lizelle Lee", batRuns: 4, batBalls: 1 },
              batsmanNonStriker: { batId: 9149, batName: "Chamari Athapaththu" },
              bowlerStriker: { bowlId: 38748, bowlName: "Eleanor Larosa" },
              extras: { wides: 1, total: 1 },
              legalRuns: 4,
              totalRuns: 5
            }]
          }]
        }
      }
    });
    expect(data.commentary).toHaveLength(2);
    expect(data.commentary[0]).toMatchObject({ inningsNumber: 0, commentary: "Teams:" });
    expect(data.deliveries).toEqual([
      expect.objectContaining({
        inningsNumber: 2,
        overNumber: 2,
        ballNumber: 2,
        batter: "Lizelle Lee",
        nonStriker: "Chamari Athapaththu",
        bowler: "Eleanor Larosa",
        batRuns: 4,
        extraRuns: 1,
        totalRuns: 5,
        eventType: "FOUR,OVER-BREAK",
        extras: { total: 1, byes: 0, legByes: 0, wides: 1, noBalls: 0, penalty: 0 }
      })
    ]);
    expect(data.coverage.deliveryCompleteness).toBe("present-unverified");
  });

  it("normalizes Cricbuzz playerData's intlTeam, bat, bowl, DoBFormat and image fields", () => {
    const $ = load("<main><h1>Emma de Broughe</h1><h2>Biography</h2><p>Player career details.</p></main>");
    const profile = normalizeCricbuzzPlayerProfile($, "https://www.cricbuzz.com/profiles/51651/emma-de-broughe", {
      rows: {
        "1": {
          playerData: {
            id: "51651",
            bat: "Right Handed Bat",
            bowl: "Right-arm offbreak",
            name: "Emma de Broughe",
            fullName: "Emma de Broughe",
            role: "Batsman",
            intlTeam: "Australia",
            teams: "Melbourne Renegades Women, Adelaide Strikers Women",
            DoB: "September 06, 2000 (26 years)",
            DoBFormat: "September 06, 2000",
            image: "http://i.cricketcb.com/stats/img/faceImages/51651.jpg"
          }
        }
      }
    });
    expect(profile).toMatchObject({
      fullName: "Emma de Broughe",
      country: "Australia",
      role: "Batsman",
      battingStyle: "Right Handed Bat",
      bowlingStyle: "Right-arm offbreak",
      birthDate: "2000-09-06",
      teams: ["Melbourne Renegades Women", "Adelaide Strikers Women"]
    });
    expect(profile.allFields).toMatchObject({
      intlTeam: "Australia",
      bat: "Right Handed Bat",
      bowl: "Right-arm offbreak",
      DoBFormat: "September 06, 2000"
    });
    expect(profile.biographySections).toEqual([
      expect.objectContaining({ heading: "Biography", text: "Player career details." })
    ]);
    expect(profile.profileImageUrl).toContain("/faceImages/51651.jpg");
  });
});

describe("deeply structured profile and match fields", () => {
  it("preserves nested profile objects, arrays, typed scalar leaves, JSON-LD and structured career statistics", () => {
    const $ = load(`
      <main><h1>Structured Player</h1><h2>Personal Information</h2><p>Source biography evidence.</p>
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Structured Player","birthDate":"2001-02-03"}</script>
      </main>`);
    const profile = normalizeCricbuzzPlayerProfile($, "https://www.cricbuzz.com/profiles/700/structured-player", {
      rows: { "1": { playerData: {
        fullName: "Structured Player",
        country: "India",
        height: "6 ft 2 in",
        teams: [{ teamId: 1, teamName: "Mumbai Indians Women" }, { teamId: 2, teamName: "Delhi Capitals Women" }],
        biography: { paragraphs: ["A complete player profile.", "A second career paragraph."] },
        careerStats: {
          ODI: { batting: { matches: 12, innings: 11, runs: 450, average: 45.0, strikeRate: 88.4 } },
          T20I: { bowling: { matches: 8, wickets: 9, economy: 6.2 } }
        }
      } } }
    });
    expect(profile).toMatchObject({
      fullName: "Structured Player",
      birthDate: "2001-02-03",
      heightCm: 187.96,
      teams: ["Mumbai Indians Women", "Delhi Capitals Women"]
    });
    expect(profile.biography).toContain("A complete player profile.");
    expect(profile.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "teams", valueType: "json" }),
      expect.objectContaining({ fieldPath: "careerStats.ODI.batting.runs", value: 450, valueType: "numeric" })
    ]));
    expect(profile.statistics).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "ODI", metricKey: "runs", valueNumeric: 450, sourcePath: expect.stringContaining("careerStats.ODI") }),
      expect.objectContaining({ section: "T20I", metricKey: "wickets", valueNumeric: 9 })
    ]));
  });

  it("keeps description, commentary, dismissal, fielding and per-delivery extras separately typed", () => {
    const data = parseCricbuzzMatchData("9988", undefined, undefined, {
      commentary: { matchPreviewFullComm: { commentary: [{
        inningsId: 1,
        commentaryList: [{
          eventId: "run-out-1",
          ballNbr: 6,
          event: "RUN_OUT",
          batsmanStriker: { batId: 101, batName: "Striker", batRuns: 0, outDesc: "run out" },
          batsmanNonStriker: { batId: 102, batName: "Non Striker" },
          bowlerStriker: { bowlId: 201, bowlName: "Bowler" },
          extrasData: { total: 1, wides: 1, byes: 0, legByes: 0, noBalls: 0, penalty: 0 },
          wicketInfo: {
            wicketType: "run out",
            playerOut: "Striker",
            playerOutId: 101,
            fieldersInvolved: [{ id: 301, name: "Keeper" }]
          },
          description: "Striker run out at the striker's end.",
          commText: "RUN OUT, batter is short of the crease."
        }]
      }] } }
    });
    expect(data.deliveries).toEqual([
      expect.objectContaining({
        sourceEventId: "run-out-1",
        overNumber: 0,
        ballNumber: 6,
        batter: "Striker",
        batterSourceId: "101",
        nonStriker: "Non Striker",
        nonStrikerSourceId: "102",
        bowler: "Bowler",
        bowlerSourceId: "201",
        extraRuns: 1,
        extraType: "wide",
        extras: { total: 1, byes: 0, legByes: 0, wides: 1, noBalls: 0, penalty: 0 },
        isWicket: true,
        dismissalType: "run out",
        dismissedPlayer: "Striker",
        dismissedPlayerSourceId: "101",
        fielder: "Keeper",
        fielderSourceId: "301",
        description: "Striker run out at the striker's end.",
        commentary: "RUN OUT, batter is short of the crease."
      })
    ]);
    expect(data.commentary[0]).toMatchObject({
      sourceEventId: "run-out-1",
      description: "Striker run out at the striker's end.",
      commentary: "RUN OUT, batter is short of the crease."
    });
  });

  it("parses extras, fall-of-wickets and partnership tables by their actual header labels", () => {
    const scorecard = load(`
      <main><h2>2nd Innings</h2>
        <table><thead><tr><th>Extras</th><th>Byes</th><th>Leg Byes</th><th>Wides</th><th>No Balls</th><th>Penalty</th></tr></thead>
          <tbody><tr><td>7</td><td>1</td><td>2</td><td>3</td><td>1</td><td>0</td></tr></tbody>
        </table>
        <table><thead><tr><th>Wicket</th><th>Score</th><th>Batter</th><th>Over</th><th>Description</th></tr></thead>
          <tbody><tr><td>1</td><td>23</td><td>Player Out</td><td>4.2</td><td>caught at deep midwicket</td></tr></tbody>
        </table>
        <table><thead><tr><th>Batter 1</th><th>Batter 2</th><th>Runs</th><th>Balls</th></tr></thead>
          <tbody><tr><td>Player A</td><td>Player B</td><td>64</td><td>42</td></tr></tbody>
        </table>
      </main>`);
    const data = parseCricbuzzMatchData("3333", scorecard, undefined);
    expect(data.innings[0]).toMatchObject({
      inningsNumber: 2,
      extras: { total: 7, byes: 1, legByes: 2, wides: 3, noBalls: 1, penalty: 0 },
      fallOfWickets: [expect.objectContaining({ wicketNumber: 1, score: 23, batterName: "Player Out", over: "4.2" })],
      partnerships: [expect.objectContaining({ batterOne: "Player A", batterTwo: "Player B", runs: 64, balls: 42 })]
    });
  });
});
