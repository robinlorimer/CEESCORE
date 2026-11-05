// /api/fixtures.js
// Returns the next scheduled fixtures for a competition (?comp=pl|ucl|uel|uecl).

// Competitions the site can show (?comp=...). IDs are API-Football league ids.
const COMPETITIONS = { pl: 39, ucl: 2, uel: 3, uecl: 848 };
const NEXT = { pl: 10, ucl: 18, uel: 18, uecl: 18 };
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
      `${BASE}/fixtures?league=${LEAGUE_ID}&season=${SEASON}&next=${NEXT[comp]}`,
      { headers: { "x-apisports-key": key } }
    );
    const json = await r.json();
    if (!r.ok || hasErr(json.errors)) {
      // Short cache so a struggling API isn't hammered by every page poll.
      res.setHeader("Cache-Control", "s-maxage=30");
      return res.status(502).json({ error: "Upstream API error", detail: json.errors });
    }
    const now = Date.now();
    const fixtures = (json.response || [])
      .map((f) => ({ f, t: new Date(f.fixture.date).getTime() }))
      // drop entries without a usable date, and "not started" games whose kick-off was hours ago
      .filter(({ t }) => Number.isFinite(t) && t > now - 3 * 3600 * 1000)
      // API-Football doesn't promise date order, so sort by kick-off ourselves
      .sort((a, b) => a.t - b.t)
      .map(({ f, t }) => {
        const tbc = f.fixture.status.short === "TBD"; // date known, kick-off time not yet confirmed
        const when = new Date(t)
          .toLocaleString("en-GB", {
            weekday: "short",
            day: "2-digit",
            month: "short",
            ...(tbc ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }),
            timeZone: "Europe/London",
          })
          .toUpperCase()
          .replace(/,/g, "");
        return { home: f.teams.home.name, away: f.teams.away.name, when: tbc ? when + " TBC" : when };
      });

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    return res.status(200).json({ fixtures });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
