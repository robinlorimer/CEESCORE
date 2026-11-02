# CEESCORE — live deploy

## What's in here
- `index.html` — the teletext page. Loads instantly with a fallback snapshot,
  then calls the `/api/*` functions below and re-renders with live data.
- `api/results.js` — last 10 finished matches + goal scorers/minutes
- `api/fixtures.js` — next 10 scheduled matches
- `api/table.js` — current league standings

These `/api/*.js` files are **Vercel Serverless Functions** — Vercel auto-detects
anything in an `/api` folder and runs it as a backend endpoint, no extra config.

## Setup (one-time)

1. Get an API-Football key: https://www.api-football.com (the $19/mo Pro plan
   covers this comfortably — see our earlier chat).
2. Push this folder to a GitHub repo, or deploy directly:
   ```
   npm i -g vercel
   cd ceescore-deploy
   vercel deploy
   ```
3. In the Vercel dashboard → your project → Settings → Environment Variables,
   add:
   ```
   API_FOOTBALL_KEY = <your key>
   ```
4. Redeploy (`vercel --prod`) so the function picks up the new env var.

## How the auto-update works
- The browser polls `/api/results`, `/api/fixtures`, `/api/table` every 30s.
- Those functions are cached at Vercel's edge for 2–5 minutes
  (`Cache-Control: s-maxage=...`), so your API-Football quota is barely
  touched no matter how many visitors you get — everyone shares the same
  cached response.
- If a function errors (key missing, API down, rate-limited) the page just
  keeps showing the last data it had — it never breaks or blanks out.

## Adjusting refresh speed
- Browser poll interval: `setInterval(fetchLive, 30000)` near the bottom of
  `index.html` — currently 30s.
- Edge cache lifetime: `s-maxage=120` (results) / `s-maxage=300` (fixtures,
  table) in each `api/*.js` file. Lower this on matchdays if you want scores
  to land faster; API-Football's free tier updates roughly every 15s anyway,
  so there's little point going below ~60s server-side.

## Season/league IDs
Currently hardcoded to Premier League (`LEAGUE_ID = 39`), season `2026` in
all three `api/*.js` files. Update those two constants if a new season
starts or you want a different competition.
