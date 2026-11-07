// /api/matchweek.js
// The current "game week" of a competition (?comp=pl|ucl|uel|uecl): every match
// in it, with live minutes, final scores and goal scorers, or kick-off times for
// games still to be played. Rolls over to the next one automatically (see pickRound).
// For European competitions a "week" is a matchday or one leg of a knockout round.
// Needs a paid API-Football plan (Pro) and the API_FOOTBALL_KEY env var.

// Competitions the site can show (?comp=...). IDs are API-Football league ids.
const COMPETITIONS = { pl: 39, ucl: 2, uel: 3, uecl: 848 };
const SEASON = 2026;
const BASE = "https://v3.football.api-sports.io";

// Stay on a finished game week for this many hours after its last match ends,
// then move on to the next one. Change this to taste.
const STAY_HOURS = 48;

// A round's fixtures are split into separate "weeks" wherever there is a gap bigger
// than this. That keeps two-legged knockout ties apart and stops one rescheduled
// match from holding a game week open for months.
const GAP_MS = 3.5 * 24 * 3600 * 1000;

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

// Split a round's fixtures wherever there is a big gap in kick-off dates.
function clusters(fixtures) {
  const sorted = [...fixtures].sort((x, y) => x.date - y.date);
  const out = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f.date - last[last.length - 1].date <= GAP_MS) last.push(f);
    else out.push([f]);
  }
  return out;
}

function labelFor(w) {
  let m;
  if ((m = w.name.match(/^Regular Season - (\d+)$/i))) return `GAME WEEK ${m[1]}` + (w.idx > 0 ? " (RESCHEDULED)" : "");
  if ((m = w.name.match(/^League Stage - (\d+)$/i))) return `MATCHDAY ${m[1]}` + (w.idx > 0 ? " (RESCHEDULED)" : "");
  let base = w.name.toUpperCase();
  if (base === "KNOCKOUT ROUND PLAY-OFFS") base = "KNOCKOUT PLAY-OFFS";
  return w.of > 1 ? `${base} - LEG ${w.idx + 1}` : base;
}

// The whole season's skeleton (every "week" with its fixture ids, dates, statuses).
// Cached on the server for 10 minutes; only used to decide WHICH week to show.
const skeletons = new Map(); // leagueId -> { at, weeks }
async function getWeeks(leagueId, key) {
  const hit = skeletons.get(leagueId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.weeks;
  const all = await api(`/fixtures?league=${leagueId}&season=${SEASON}`, key);
  const byRound = new Map();
  for (const f of all) {
    const name = f.league.round;
    if (!byRound.has(name)) byRound.set(name, []);
    byRound.get(name).push({
      id: f.fixture.id,
      date: new Date(f.fixture.date).getTime(),
      short: f.fixture.status.short,
      round: name,
    });
  }
  const weeks = [];
  for (const [name, fs] of byRound) {
    const cl = clusters(fs);
    cl.forEach((fixtures, idx) => weeks.push({ name, idx, of: cl.length, start: fixtures[0].date, fixtures }));
  }
  weeks.sort((a, b) => a.start - b.start);
  for (const w of weeks) w.label = labelFor(w);
  skeletons.set(leagueId, { at: Date.now(), weeks });
  return weeks;
}

// The current week is the earliest one that is not "settled".
// A week is settled once every match in it has finished (postponed ones
// don't count) AND STAY_HOURS have passed since the last final whistle.
function pickRound(weeks, now) {
  const settled = (r) => {
    const finished = r.fixtures.filter((f) => FINISHED.has(f.short));
    const open = r.fixtures.some((f) => !FINISHED.has(f.short) && !DEAD.has(f.short));
    if (open || !finished.length) return false;
    const end = Math.max(...finished.map((f) => f.date)) + 2.5 * 3600 * 1000;
    return now > end + STAY_HOURS * 3600 * 1000;
  };
  return weeks.find((r) => !settled(r)) || weeks[weeks.length - 1];
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

// A goal ruled out by VAR. API-Football keeps the original "Goal" event and adds a
// separate "Var" event ("Goal cancelled", "Goal Disallowed - offside", ...), so the two
// have to be matched up. The score the API reports already leaves the goal out.
const isCancelled = (e) => /(cancel+ed|disallow)/i.test(e.detail || "");
const stamp = (e) => (e.time.elapsed || 0) * 100 + (e.time.extra || 0);

// Split a match's goal events into home / away scorers, flagging disallowed goals.
// If own goals are credited to the wrong side (the totals won't match the
// score), flip them.
function toGoals(events, f) {
  const homeId = f.teams.home.id;
  const hs = f.goals.home ?? 0;
  const as = f.goals.away ?? 0;
  const all = (events || []).filter((e) => e.time).sort((x, y) => stamp(x) - stamp(y));
  const goals = all
    .filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty")
    .map((e) => ({ e, dis: isCancelled(e) }));
  // Match each VAR "goal cancelled" event to the closest earlier goal (the same team's if possible)
  for (const v of all.filter((e) => e.type === "Var" && isCancelled(e))) {
    const near = goals.filter((g) => !g.dis && stamp(g.e) <= stamp(v) && v.time.elapsed - g.e.time.elapsed <= 6);
    const pick = [...near].reverse().find((g) => g.e.team.id === v.team.id) || near[near.length - 1];
    if (pick) pick.dis = true;
  }
  const build = (flipOwnGoals) => {
    const gh = [], ga = [];
    for (const { e, dis } of goals) {
      let isHome = e.team.id === homeId;
      if (flipOwnGoals && e.detail === "Own Goal") isHome = !isHome;
      (isHome ? gh : ga).push({
        p: (e.player && e.player.name) || "Unknown",
        t: minute(e),
        og: e.detail === "Own Goal",
        pen: e.detail === "Penalty",
        ...(dis ? { dis: true } : {}),
      });
    }
    return { gh, ga };
  };
  // only goals that stood count towards the score
  const stood = (o) => [o.gh.filter((g) => !g.dis).length, o.ga.filter((g) => !g.dis).length];
  let out = build(false);
  const [h0, a0] = stood(out);
  if ((h0 !== hs || a0 !== as) && goals.some((g) => g.e.detail === "Own Goal")) {
    const alt = build(true);
    const [h1, a1] = stood(alt);
    if (h1 === hs && a1 === as) out = alt;
  }
  return out;
}

// Finished matches never change, so remember their goals on this server instance.
const goalsCache = new Map();

export default async function handler(req, res) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: "Missing API_FOOTBALL_KEY env var" });

  const comp = (req.query && req.query.comp) || "pl";
  const LEAGUE_ID = COMPETITIONS[comp];
  if (!LEAGUE_ID) return res.status(400).json({ error: "Unknown competition" });

  try {
    const now = Date.now();
    const weeks = await getWeeks(LEAGUE_ID, key);
    if (!weeks.length) return res.status(200).json({ label: "", matches: [], live: false });
    const round = pickRound(weeks, now);
    const wanted = new Set(round.fixtures.map((f) => f.id));

    // Fresh statuses and scores for just this week
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
    return res.status(200).json({ label: round.label, matches, live: anyLive });
  } catch (err) {
    if (err.upstream !== undefined) {
      res.setHeader("Cache-Control", "s-maxage=30");
      return res.status(502).json({ error: "Upstream API error", detail: err.upstream });
    }
    return res.status(500).json({ error: String(err) });
  }
}
