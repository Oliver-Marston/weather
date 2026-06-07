// ════════════════════════════════════════════════════════════════
//  Backfill 12 months for any NON-home location that has no readings
//  yet (e.g. a newly-added favourite synced from the app). Idempotent:
//  locations that already have data are skipped. Runs in the cron and
//  can be run manually:  node scripts/backfill-new.mjs
// ════════════════════════════════════════════════════════════════

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing Supabase env'); process.exit(1); }

const SB = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const dewPoint = (t, h) => { if (t == null || h == null) return null; const a = 17.27, b = 237.7, al = ((a * t) / (b + t)) + Math.log(h / 100); return (b * al) / (a - al); };
const feelsLike = (t, h, w) => { if (t == null || h == null) return t; const e = (h / 100) * 6.105 * Math.exp((17.27 * t) / (237.7 + t)); return t + 0.33 * e - 0.70 * ((w || 0) / 3.6) - 4; };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getLocations() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/locations?select=*`, { headers: SB });
  if (!r.ok) throw new Error(`locations ${r.status}`);
  return r.json();
}
async function hasReadings(key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/readings?location_key=eq.${encodeURIComponent(key)}&select=id&limit=1`, { headers: SB });
  const d = await r.json();
  return Array.isArray(d) && d.length > 0;
}
async function bulkInsert(rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/readings`, { method: 'POST', headers: { ...SB, Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
    if (!r.ok) throw new Error(`insert ${r.status}: ${await r.text()}`);
    n += chunk.length;
  }
  return n;
}

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
  const locs = (await getLocations()).filter(l => !l.is_home);
  let did = 0;
  for (const loc of locs) {
    if (await hasReadings(loc.key)) { continue; }
    const rows = [...await archive(loc), ...await recent(loc)];
    if (!rows.length) { console.log(`· ${loc.key}: no data returned`); continue; }
    const n = await bulkInsert(rows);
    console.log(`✓ backfilled ${loc.key} (${loc.name}): ${n} rows`);
    did++; await sleep(400);
  }
  console.log(did ? `Backfilled ${did} new location(s)` : 'No new locations to backfill');
})();
