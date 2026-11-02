// /api/table.js
// Returns the current Premier League standings.

const LEAGUE_ID = 39;
const SEASON = 2026;
const BASE = "https://v3.football.api-sports.io";

export default async function handler(req, res) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing API_FOOTBALL_KEY env var" });
  }

  try {
    const r = await fetch(
      `${BASE}/standings?league=${LEAGUE_ID}&season=${SEASON}`,
      { headers: { "x-apisports-key": key } }
    );
    const json = await r.json();
    const rows = json.response?.[0]?.league?.standings?.[0] || [];
    const table = rows.map((row) => ({
      team: row.team.name,
      p: row.all.played,
      w: row.all.win,
      d: row.all.draw,
      l: row.all.lose,
      pts: row.points,
    }));

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    return res.status(200).json({ table, errors: json.errors, results: json.results });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
