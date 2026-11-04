// /api/table.js
// Returns the current standings for a competition (?comp=pl|ucl|uel|uecl).
// For the European competitions this is the league-phase table.

// Competitions the site can show (?comp=...). IDs are API-Football league ids.
const COMPETITIONS = { pl: 39, ucl: 2, uel: 3, uecl: 848 };
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

  const comp = (req.query && req.query.comp) || "pl";
  const LEAGUE_ID = COMPETITIONS[comp];
  if (!LEAGUE_ID) return res.status(400).json({ error: "Unknown competition" });

  try {
    const r = await fetch(
      `${BASE}/standings?league=${LEAGUE_ID}&season=${SEASON}`,
      { headers: { "x-apisports-key": key } }
    );
    const json = await r.json();
    if (!r.ok || hasErr(json.errors)) {
      // Short cache so a struggling API isn't hammered by every page poll.
      res.setHeader("Cache-Control", "s-maxage=30");
      return res.status(502).json({ error: "Upstream API error", detail: json.errors });
    }
    const rows = json.response?.[0]?.league?.standings?.[0] || [];
    const table = rows.map((row) => ({
      team: row.team.name,
      p: row.all.played,
      w: row.all.win,
      d: row.all.draw,
      l: row.all.lose,
      pts: row.points,
      gd: row.goalsDiff,
    }));

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    return res.status(200).json({ table });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
