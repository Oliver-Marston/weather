// ════════════════════════════════════════════════════════════════
//  Backfill history for anything newly added and still empty:
//   • forecast locations (union of all users' favourites): 12 months
//     via Open-Meteo (archive 365→91d ago + forecast past_days=90)
//   • user stations: available recent Ecowitt history (~30 days)
//  Idempotent — anything that already has readings is skipped.
//  Runs in the cron before ingest; can be run manually.
// ════════════════════════════════════════════════════════════════

import {
  requireEnv, getActiveLocations, getUserStations, hasReadings, bulkInsert,
  ecowittHistory, num, dewPoint, feelsLike, ymd, sleep,
} from './lib.mjs';

requireEnv();

// Recent 90 days (forecast API, includes uv_index)
async function recent(loc) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,windspeed_10m,winddirection_10m,windgusts_10m,weathercode,uv_index`
    + `&past_days=90&forecast_days=1&timezone=GMT`;
  const h = (await (await fetch(u)).json()).hourly; if (!h?.time) return [];
  return h.time.map((t, i) => {
    const temp = num(h.temperature_2m[i]), hum = num(h.relative_humidity_2m[i]), wind = num(h.windspeed_10m[i]);
    return { location_key: loc.key, observed_at: `${t}:00Z`, source: 'open-meteo', temp, feels_like: feelsLike(temp, hum, wind),
      humidity: hum, dew_point: num(h.dew_point_2m[i]) ?? dewPoint(temp, hum), pressure: num(h.surface_pressure[i]),
      wind_speed: wind, wind_gust: num(h.windgusts_10m[i]), wind_dir: num(h.winddirection_10m[i]),
      uv: num(h.uv_index[i]), weathercode: h.weathercode[i] ?? null };
  }).filter(r => r.temp != null);
}

// 365→91 days ago (archive API / ERA5)
async function archive(loc) {
  const now = Date.now();
  const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&start_date=${ymd(new Date(now - 365 * 86400000))}&end_date=${ymd(new Date(now - 91 * 86400000))}`
    + `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code&timezone=GMT`;
  const h = (await (await fetch(u)).json()).hourly; if (!h?.time) return [];
  return h.time.map((t, i) => {
    const temp = num(h.temperature_2m[i]), hum = num(h.relative_humidity_2m[i]), wind = num(h.wind_speed_10m[i]);
    return { location_key: loc.key, observed_at: `${t}:00Z`, source: 'open-meteo-archive', temp, feels_like: feelsLike(temp, hum, wind),
      humidity: hum, dew_point: num(h.dew_point_2m[i]) ?? dewPoint(temp, hum), pressure: num(h.surface_pressure[i]),
      wind_speed: wind, wind_gust: num(h.wind_gusts_10m[i]), wind_dir: num(h.wind_direction_10m[i]),
      uv: null, weathercode: h.weather_code[i] ?? null };
  }).filter(r => r.temp != null);
}

(async () => {
  let did = 0;
  for (const loc of await getActiveLocations()) {
    if (await hasReadings(loc.key)) continue;
    const rows = [...await archive(loc), ...await recent(loc)];
    if (!rows.length) { console.log(`· ${loc.key}: no data returned`); continue; }
    const n = await bulkInsert(rows);
    console.log(`✓ backfilled ${loc.key} (${loc.name}): ${n} rows`);
    did++; await sleep(400);
  }
  for (const st of await getUserStations()) {
    if (await hasReadings(st.station_key)) continue;
    const rows = await ecowittHistory({ app_key: st.app_key, api_key: st.api_key, mac: st.mac }, st.station_key, 30);
    if (!rows.length) { console.log(`· station ${st.name}: no history`); continue; }
    const n = await bulkInsert(rows);
    console.log(`✓ backfilled station ${st.name}: ${n} rows`);
    did++;
  }
  console.log(did ? `Backfilled ${did} new item(s)` : 'No new items to backfill');
})();
