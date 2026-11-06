# CEESCORE — live deploy

## Files
- `index.html` — the teletext page. It has no built-in scores: it asks the `/api/*` functions
  for whichever competition is selected, every 20 seconds, and shows the teletext error page
  if they can't be reached.
- `api/matchweek.js` — the current game week / matchday: live minutes, final scores, goal
  scorers, kick-off times (powers P302 and the live table)
- `api/fixtures.js` — upcoming fixtures (P303)
- `api/table.js` — standings (P301). For the European competitions this is the league-phase table.

All three take `?comp=pl|ucl|uel|uecl` (Premier League, Champions League, Europa League,
Conference League). The site picks the competition from the tabs at the top, and
`yoursite.vercel.app/#ucl` links straight to one (`#pl`, `#ucl`, `#uel`, `#uecl`).

Vercel runs everything in `/api` as server functions. Your API-Football key lives only in the
Vercel environment variable `API_FOOTBALL_KEY`.

## How the game week moves on by itself
`api/matchweek.js` reads the season's fixtures from API-Football and shows the earliest "week"
that is not settled. A week is settled once every match in it has finished (postponed ones
don't count) **and 48 hours have passed since the last final whistle**; then it moves on.
- Premier League: a week is a game week. European competitions: a matchday, or one leg of a
  knockout round ("ROUND OF 16 - LEG 1", "LEG 2", ...).
- Fixtures in the same round more than 3.5 days apart count as separate weeks, so a match
  rescheduled months later can't hold the current week open.
- Change the 48 hours with `STAY_HOURS` at the top of `api/matchweek.js`.
- The season (`SEASON = 2026`) and league ids are at the top of each function.

## Hidden for now
The Support page (P695) is hidden. To bring it back, uncomment the `695 SUPPORT` button in the
nav bar in `index.html`.

## Caching (protects your 7,500 requests/day)
- Match data is cached at Vercel's edge for 20s while a match is live, 60s within 2 hours of
  kick-off, otherwise 5 minutes. Fixtures and table: 5 minutes.
- Only the competition being viewed is fetched, so each extra competition costs nothing until
  someone opens it.
- If a function fails, the page shows the teletext "SERVICE UNAVAILABLE" page.

## Setup
1. Needs the API-Football **Pro** plan (the free plan can't read the current season).
2. Add `API_FOOTBALL_KEY` in Vercel -> Settings -> Environment Variables, then redeploy.
3. Check `your-site.vercel.app/api/matchweek?comp=ucl` shows match data.
