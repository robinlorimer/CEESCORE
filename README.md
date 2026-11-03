# CEESCORE — live deploy

## Files
- `index.html` — the teletext page. Shows a built-in snapshot instantly, then
  calls the `/api/*` functions every 20 seconds.
- `api/matchweek.js` — the current game week: live minutes, final scores, goal
  scorers, and kick-off times for games still to play (powers P302 and the live table).
- `api/fixtures.js` — next 10 scheduled matches (P303)
- `api/table.js` — league standings (P301)

Vercel runs everything in `/api` as server functions. Your API-Football key
lives only in the Vercel environment variable `API_FOOTBALL_KEY`.

## How the game week moves on by itself
`api/matchweek.js` reads the season's rounds from API-Football and shows the
earliest game week that is not "settled". A game week is settled once every
match in it has finished (postponed matches don't count) **and 48 hours have
passed since the last final whistle**. At that point the page rolls over to the
next game week, which starts out showing kick-off times and fills in scores as
games are played.
- Change the 48 hours with `STAY_HOURS` at the top of `api/matchweek.js`.
- A match postponed to a date far outside its game week is treated as
  rescheduled and can't hold that week open.
- Season is hard-coded (`SEASON = 2026`, `LEAGUE_ID = 39`) at the top of each
  function; update it when a new season starts.

## Caching (protects your 7,500 requests/day)
- Game week data is cached at Vercel's edge for 20s while a match is live,
  60s within 2 hours of kick-off, otherwise 5 minutes.
- Fixtures and table: 5 minutes.
- If a function fails, the page shows the teletext "SERVICE UNAVAILABLE" page.

## Setup
1. Needs the API-Football **Pro** plan (the free plan can't read the current season).
2. Add `API_FOOTBALL_KEY` in Vercel -> Settings -> Environment Variables, then redeploy.
3. Check `your-site.vercel.app/api/matchweek` shows match data.
