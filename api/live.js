// /api/live.js
// Premier League matches in play right now: score, minute and goals so far.
// Needs a paid API-Football plan (Pro) and the API_FOOTBALL_KEY env var.

const LEAGUE_ID = 39;
const BASE = "https://v3.football.api-sports.io";

export default async function handler(req, res) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing API_FOOTBALL_KEY env var" });
  }

  try {
    const r = await fetch(`${BASE}/fixtures?live=${LEAGUE_ID}`, {
      headers: { "x-apisports-key": key },
    });
    const json = await r.json();

    const live = (json.response || []).map((f) => {
      const goals = (f.events || []).filter(
        (e) => e.type === "Goal" && e.detail !== "Missed Penalty"
      );
      const side = (teamId) =>
        goals
          .filter((g) => g.team.id === teamId)
          .map((g) => ({
            p: g.player.name,
            t: String(g.time.elapsed) + (g.time.extra ? `+${g.time.extra}` : ""),
            og: g.detail === "Own Goal",
            pen: g.detail === "Penalty",
          }));

      const short = f.fixture.status.short;
      let status = `${f.fixture.status.elapsed ?? ""}'`;
      if (short === "HT") status = "HT";
      else if (short === "P") status = "PEN";
      else if (short === "BT") status = "ET";

      return {
        home: f.teams.home.name,
        away: f.teams.away.name,
        hs: f.goals.home ?? 0,
        as: f.goals.away ?? 0,
        status,
        live: true,
        gh: side(f.teams.home.id),
        ga: side(f.teams.away.id),
      };
    });

    // Short cache while a match is on, longer when nothing is live
    // (keeps within the Pro plan's 7,500 requests/day).
    res.setHeader(
      "Cache-Control",
      live.length
        ? "s-maxage=20, stale-while-revalidate=20"
        : "s-maxage=120, stale-while-revalidate=60"
    );
    return res.status(200).json({ live, errors: json.errors });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
