# Weathered World

Multi-tenant weather web app (installable PWA): live personal weather stations
(Ecowitt), forecasts for favourite places, and a year of history with trend
charts and multi-location comparison.

- **App:** `index.html` — single self-contained file (inline CSS/JS, no build
  step), deployed from the repo root via Netlify. Live at
  https://ecowitt-burton-on-the-wolds.netlify.app (moving to app.weathered.world).
- **Marketing site:** `web/index.html` — static landing page (intended for
  weathered.world as a second Netlify site with publish dir `web`).

## Architecture

- **Auth + data: Supabase** (project ref `xysslvzlmpgmseimqito`).
  Schema in `supabase/schema.sql`:
  - `user_locations` / `user_stations` — per-user favourites and stations,
    RLS owner-only. Station rows hold the user's Ecowitt keys (readable only
    by the owner and the server-side cron).
  - `locations` — shared registry/history cache of forecast places.
  - `readings` — the time-series. Charts read it via the whitelisted
    `get_history(location, metric, since, buckets)` RPC (server-side
    bucketing/averaging).
- **Ingestion:** `.github/workflows/ingest.yml` every 30 min runs
  `scripts/backfill-new.mjs` (backfills anything new: 12 months for forecast
  places, ~30 days of Ecowitt history for new stations) then
  `scripts/ingest.mjs` (logs a current reading for every active favourite and
  every user station). Shared helpers in `scripts/lib.mjs`.
  Secrets required: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (GitHub Actions).
- **Service worker:** `sw.js`, network-first. Bump `VERSION` there **and**
  `APP_BUILD` in `index.html` together on every deploy — this is how installed
  PWAs pick up updates.
- **Vendored:** `vendor/supabase.js` = @supabase/supabase-js v2 UMD build
  (from jsDelivr, vendored 2026-06-08 so the PWA has no CDN dependency).
- `scripts/make_icons.py` — one-off generator for the app icons (Pillow).

## Local scripts

```
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/ingest.mjs
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/backfill-new.mjs
```

Local secrets live in `.env` (gitignored). Never commit keys — the repo is public.
