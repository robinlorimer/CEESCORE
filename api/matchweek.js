// /api/matchweek.js
// The current Premier League "game week": every match in it, with live
// minutes, final scores and goal scorers, or kick-off times for games still
// to be played. Rolls over to the next game week automatically (see pickRound).
// Needs a paid API-Football plan (Pro) and the API_FOOTBALL_KEY env var.

const LEAGUE_ID = 39;
const SEASON = 2026;
const BASE = "https://v3.football.api-sports.io";

// Stay on a finished game week for this many hours after its last match ends,
// then move on to the next one. Change this to taste.
const STAY_HOURS = 48;

// Fixtures further than this from a round's median date are treated as
// rescheduled games, so one postponed match can't hold a game week open forever.
const ROUND_WINDOW_MS = 3.5 * 24 * 3600 * 1000;

const FINISHED = new Set(["FT", "AET", "PEN", "AWD", "WO"]);
const DEAD = new Set(["PST", "CANC", "ABD"]);
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);

// API-Football reports problems inside an "errors" field while still answering HTTP 200.
const hasErr = (e) => !!e && (Array.isArray(e) ? e.length > 0 : Object.keys(e).length > 0);

async function api(path, key) {
  const r = await fetch(`${BASE}${path}`, { headers: { "x-apisports-key": key } });
  const json = await r.json();
  if (!r.ok || hasErr(json.errors)) {
    const err = new Error("Upstream API error");
    err.upstream = json.errors || [];
    throw err;
  }
  return json.response || [];
}

const roundNumber = (name) => {
  const m = String(name).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
};

function windowed(fixtures) {
  const dates = fixtures.map((f) => f.date).sort((a, b) => a - b);
  const median = dates[Math.floor(dates.length / 2)];
  return fixtures.filter((f) => Math.abs(f.date - median) <= ROUND_WINDOW_MS);
}

// The whole season's skeleton (round -> fixture ids, dates, statuses).
// Cached on the server for 10 minutes; only used to decide WHICH game week to show.
let skeleton = { at: 0, rounds: null };
async function getRounds(key) {
  if (skeleton.rounds && Date.now() - skeleton.at < 10 * 60 * 1000) return skeleton.rounds;
  const all = await api(`/fixtures?league=${LEAGUE_ID}&season=${SEASON}`, key);
  const byRound = new Map();
  for (const f of all) {
    const name = f.league.round;
    if (!byRound.has(name)) byRound.set(name, []);
    byRound.get(name).push({
      id: f.fixture.id,
      date: new Date(f.fixture.date).getTime(),
      short: f.fixture.status.short,
    });
  }
  const rounds = [...byRound]
    .map(([name, fixtures]) => ({ name, num: roundNumber(name), fixtures: windowed(fixtures) }))
    .sort((a, b) => a.num - b.num);
  skeleton = { at: Date.now(), rounds };
  return rounds;
}

// The current game week is the earliest one that is not "settled".
// A game week is settled once every match in it has finished (postponed ones
// don't count) AND STAY_HOURS have passed since the last final whistle.
function pickRound(rounds, now) {
  const settled = (r) => {
    const finished = r.fixtures.filter((f) => FINISHED.has(f.short));
    const open = r.fixtures.some((f) => !FINISHED.has(f.short) && !DEAD.has(f.short));
    if (open || !finished.length) return false;
    const end = Math.max(...finished.map((f) => f.date)) + 2.5 * 3600 * 1000;
    return now > end + STAY_HOURS * 3600 * 1000;
  };
  return rounds.find((r) => !settled(r)) || rounds[rounds.length - 1];
}

const when = (iso) =>
  new Date(iso)
    .toLocaleString("en-GB", {
      weekday: "short", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London",
    })
    .toUpperCase()
    .replace(/,/g, "");

const minute = (e) => String(e.time.elapsed) + (e.time.extra ? `+${e.time.extra}` : "");

// Split a match's goal events into home / away scorers.
// If own goals are credited to the wrong side (the totals won't match the
// score), flip them.
function toGoals(events, f) {
  const homeId = f.teams.home.id;
  const hs = f.goals.home ?? 0;
  const as = f.goals.away ?? 0;
  const goals = (events || []).filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty");
  const build = (flipOwnGoals) => {
    const gh = [], ga = [];
    for (const e of goals) {
      let isHome = e.team.id === homeId;
      if (flipOwnGoals && e.detail === "Own Goal") isHome = !isHome;
      (isHome ? gh : ga).push({
        p: (e.player && e.player.name) || "Unknown",
        t: minute(e),
        og: e.detail === "Own Goal",
        pen: e.detail === "Penalty",
      });
    }
    return { gh, ga };
  };
  let out = build(false);
  if ((out.gh.length !== hs || out.ga.length !== as) && goals.some((e) => e.detail === "Own Goal")) {
    const alt = build(true);
    if (alt.gh.length === hs && alt.ga.length === as) out = alt;
  }
  return out;
}

// Finished matches never change, so remember their goals on this server instance.
const goalsCache = new Map();

export default async function handler(req, res) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: "Missing API_FOOTBALL_KEY env var" });

  try {
    const now = Date.now();
    const rounds = await getRounds(key);
    if (!rounds.length) return res.status(200).json({ round: 0, matches: [], live: false });
    const round = pickRound(rounds, now);
    const wanted = new Set(round.fixtures.map((f) => f.id));

    // Fresh statuses and scores for just this game week
    const fresh = await api(
      `/fixtures?league=${LEAGUE_ID}&season=${SEASON}&round=${encodeURIComponent(round.name)}`,
      key
    );
    const fx = fresh
      .filter((f) => wanted.has(f.fixture.id))
      .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

    // Goal events for matches that have started
    const started = fx.filter((f) => LIVE.has(f.fixture.status.short) || FINISHED.has(f.fixture.status.short));
    const eventsById = new Map();
    for (const f of started) if (Array.isArray(f.events)) eventsById.set(f.fixture.id, f.events);
    const need = started.filter(
      (f) => !eventsById.has(f.fixture.id) && !(FINISHED.has(f.fixture.status.short) && goalsCache.has(f.fixture.id))
    );
    try {
      for (let i = 0; i < need.length; i += 20) {
        const ids = need.slice(i, i + 20).map((f) => f.fixture.id).join("-");
        for (const r of await api(`/fixtures?ids=${ids}`, key)) {
          if (Array.isArray(r.events)) eventsById.set(r.fixture.id, r.events);
        }
      }
      // Anything still missing: one call per fixture
      for (const f of need) {
        if (!eventsById.has(f.fixture.id)) {
          eventsById.set(f.fixture.id, await api(`/fixtures/events?fixture=${f.fixture.id}`, key));
        }
      }
    } catch (e) {
      // Goal scorers are a bonus; the scores still go out without them.
    }

    const matches = fx.map((f) => {
      const short = f.fixture.status.short;
      const live = LIVE.has(short);
      const final = FINISHED.has(short);
      let status = short;
      if (final) status = "FT";
      else if (live) {
        if (short === "HT") status = "HT";
        else if (short === "P") status = "PEN";
        else if (short === "BT") status = "ET";
        else if (short === "SUSP" || short === "INT") status = short;
        else status = `${f.fixture.status.elapsed ?? ""}'`;
      }
      let goals = { gh: [], ga: [] };
      if (live || final) {
        if (final && goalsCache.has(f.fixture.id)) goals = goalsCache.get(f.fixture.id);
        else if (eventsById.has(f.fixture.id)) {
          goals = toGoals(eventsById.get(f.fixture.id), f);
          if (final) goalsCache.set(f.fixture.id, goals);
        }
      }
      return {
        home: f.teams.home.name,
        away: f.teams.away.name,
        hs: f.goals.home,
        as: f.goals.away,
        status,
        live,
        final,
        when: when(f.fixture.date),
        gh: goals.gh,
        ga: goals.ga,
      };
    });

    const anyLive = matches.some((m) => m.live);
    const kickingOffSoon = fx.some((f) => {
      const t = new Date(f.fixture.date).getTime() - now;
      return f.fixture.status.short === "NS" && t < 2 * 3600 * 1000 && t > -3600 * 1000;
    });
    res.setHeader(
      "Cache-Control",
      anyLive
        ? "s-maxage=20, stale-while-revalidate=20"
        : kickingOffSoon
        ? "s-maxage=60, stale-while-revalidate=30"
        : "s-maxage=300, stale-while-revalidate=60"
    );
    return res.status(200).json({ round: round.num, matches, live: anyLive });
  } catch (err) {
    if (err.upstream !== undefined) {
      res.setHeader("Cache-Control", "s-maxage=30");
      return res.status(502).json({ error: "Upstream API error", detail: err.upstream });
    }
    return res.status(500).json({ error: String(err) });
  }
}
