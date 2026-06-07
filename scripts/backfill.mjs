// ════════════════════════════════════════════════════════════════
//  One-off backfill — seeds historical readings into Supabase.
//   • Home: ~8 days from the Ecowitt history endpoint (30-min cycle)
//   • Saved locations: 90 days from Open-Meteo (hourly)
//  Run locally:  node scripts/backfill.mjs   (env same as ingest.mjs)
// ════════════════════════════════════════════════════════════════

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  ECOWITT_APP_KEY, ECOWITT_API_KEY, ECOWITT_MAC,
} = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing Supabase env'); process.exit(1); }

const SB = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const dewPoint = (t, h) => { if (t == null || h == null) return null; const a = 17.27, b = 237.7, al = ((a * t) / (b + t)) + Math.log(h / 100); return (b * al) / (a - al); };
const feelsLike = (t, h, w) => { if (t == null || h == null) return t; const e = (h / 100) * 6.105 * Math.exp((17.27 * t) / (237.7 + t)); return t + 0.33 * e - 0.70 * ((w || 0) / 3.6) - 4; };
const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getLocations() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/locations?select=*`, { headers: SB });
  if (!r.ok) throw new Error(`locations ${r.status}`);
  return r.json();
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

async function backfillHome() {
  if (!ECOWITT_APP_KEY) { console.log('· skip home (no Ecowitt env)'); return; }
  const rows = [];
  const now = new Date();
  for (let day = 8; day >= 0; day--) {
    const d = new Date(now.getTime() - day * 86400000);
    const start = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}%2000:00:00`;
    const end = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}%2023:59:59`;
    const u = `https://api.ecowitt.net/api/v3/device/history?application_key=${ECOWITT_APP_KEY}&api_key=${ECOWITT_API_KEY}&mac=${ECOWITT_MAC}`
      + `&start_date=${start}&end_date=${end}&cycle_type=30min`
      + `&call_back=outdoor,wind,pressure,solar_and_uvi,rainfall_piezo,indoor,soil_ch1`
      + `&temp_unitid=1&pressure_unitid=3&wind_speed_unitid=7&rainfall_unitid=12&solar_irradiance_unitid=16`;
    const j = await (await fetch(u)).json();
    if (j.code !== 0) { console.log(`· home ${start.slice(0,10)}: ${j.msg}`); await sleep(400); continue; }
    const cats = j.data || {};
    const tempList = cats.outdoor?.temperature?.list || {};
    const g = (cat, field, t) => num(cats?.[cat]?.[field]?.list?.[t]);
    for (const t of Object.keys(tempList)) {
      const vpd = g('outdoor', 'vpd', t);
      rows.push({
        location_key: 'home', observed_at: new Date(+t * 1000).toISOString(), source: 'ecowitt',
        temp: num(tempList[t]), feels_like: g('outdoor', 'feels_like', t) ?? g('outdoor', 'app_temp', t),
        humidity: g('outdoor', 'humidity', t), dew_point: g('outdoor', 'dew_point', t),
        pressure: g('pressure', 'relative', t), pressure_abs: g('pressure', 'absolute', t),
        wind_speed: g('wind', 'wind_speed', t), wind_gust: g('wind', 'wind_gust', t), wind_dir: g('wind', 'wind_direction', t),
        uv: g('solar_and_uvi', 'uvi', t), solar: g('solar_and_uvi', 'solar', t),
        rain_rate: g('rainfall_piezo', 'rain_rate', t),
        indoor_temp: g('indoor', 'temperature', t), indoor_humidity: g('indoor', 'humidity', t),
        soil_moisture: g('soil_ch1', 'soilmoisture', t),
        vpd: vpd == null ? null : vpd * 3.386389,
      });
    }
    await sleep(400);
  }
  const n = await bulkInsert(rows);
  console.log(`✓ home: ${n} rows`);
}

async function backfillLocation(loc) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,windspeed_10m,winddirection_10m,windgusts_10m,weathercode,uv_index`
    + `&past_days=90&forecast_days=1&timezone=GMT`;
  const j = await (await fetch(u)).json();
  const h = j.hourly; if (!h?.time) { console.log(`· ${loc.key}: no data`); return; }
  const rows = [];
  for (let i = 0; i < h.time.length; i++) {
    const temp = num(h.temperature_2m[i]), hum = num(h.relative_humidity_2m[i]), wind = num(h.windspeed_10m[i]);
    rows.push({
      location_key: loc.key, observed_at: `${h.time[i]}:00Z`, source: 'open-meteo',
      temp, feels_like: feelsLike(temp, hum, wind), humidity: hum,
      dew_point: num(h.dew_point_2m[i]) ?? dewPoint(temp, hum),
      pressure: num(h.surface_pressure[i]),
      wind_speed: wind, wind_gust: num(h.windgusts_10m[i]), wind_dir: num(h.winddirection_10m[i]),
      uv: num(h.uv_index[i]), weathercode: h.weathercode[i] ?? null,
    });
  }
  const n = await bulkInsert(rows);
  console.log(`✓ ${loc.key}: ${n} rows`);
}

(async () => {
  const locs = await getLocations();
  await backfillHome();
  for (const loc of locs.filter(l => !l.is_home)) { await backfillLocation(loc); await sleep(300); }
  console.log('Backfill complete');
})();
