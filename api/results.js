// /api/results.js
// Returns the last N finished Premier League matches, with goal scorers + minutes.
// Requires env var API_FOOTBALL_KEY (set in Vercel project settings -> Environment Variables).

const LEAGUE_ID = 39; // Premier League
const SEASON = 2026;
const BASE = "https://v3.football.api-sports.io";

// API-Football reports problems (bad key, plan limits, rate limits) inside an
// "errors" field while still answering HTTP 200. Detect that here.
const hasErr = (e) => !!e && (Array.isArray(e) ? e.length > 0 : Object.keys(e).length > 0);

export default async function handler(req, res) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing API_FOOTBALL_KEY env var" });
  }

  const headers = { "x-apisports-key": key };

  try {
    // 1. Get last 10 finished fixtures
    const fixturesRes = await fetch(
      `${BASE}/fixtures?league=${LEAGUE_ID}&season=${SEASON}&status=FT&last=10`,
      { headers }
    );
    const fixturesJson = await fixturesRes.json();
    if (!fixturesRes.ok || hasErr(fixturesJson.errors)) {
      // Short cache so a struggling API isn't hammered by every page poll.
      res.setHeader("Cache-Control", "s-maxage=30");
      return res.status(502).json({ error: "Upstream API error", detail: fixturesJson.errors });
    }
    const fixtures = fixturesJson.response || [];

    // 2. For each, fetch events (goals) in parallel
    const withEvents = await Promise.all(
      fixtures.map(async (f) => {
        const evRes = await fetch(
          `${BASE}/fixtures/events?fixture=${f.fixture.id}`,
          { headers }
        );
        const evJson = await evRes.json();
        const goals = (evJson.response || []).filter(
          (e) => e.type === "Goal"
        );

        return {
          home: f.teams.home.name,
          away: f.teams.away.name,
          hs: f.goals.home,
          as: f.goals.away,
          status: "FT",
          gh: goals
            .filter((g) => g.team.id === f.teams.home.id)
            .map((g) => ({
              p: g.player.name,
              t: String(g.time.elapsed) + (g.time.extra ? `+${g.time.extra}` : ""),
              og: g.detail === "Own Goal",
              pen: g.detail === "Penalty",
            })),
          ga: goals
            .filter((g) => g.team.id === f.teams.away.id)
            .map((g) => ({
              p: g.player.name,
              t: String(g.time.elapsed) + (g.time.extra ? `+${g.time.extra}` : ""),
              og: g.detail === "Own Goal",
              pen: g.detail === "Penalty",
            })),
        };
      })
    );

    // Cache at the edge for 5 minutes; serve stale for up to 1 more minute while revalidating
    res.setHeader(
      "Cache-Control",
      "s-maxage=300, stale-while-revalidate=60"
    );
    return res.status(200).json({ results: withEvents });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
