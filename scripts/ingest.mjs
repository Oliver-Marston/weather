// ════════════════════════════════════════════════════════════════
//  Weather ingestion — runs in GitHub Actions on a schedule.
//  Reads the tracked locations from Supabase, pulls current readings
//  (Ecowitt for home, Open-Meteo for the rest), and inserts rows.
//
//  Required env (set as GitHub repository secrets):
//    SUPABASE_URL, SUPABASE_SERVICE_KEY,
//    ECOWITT_APP_KEY, ECOWITT_API_KEY, ECOWITT_MAC
// ════════════════════════════════════════════════════════════════

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  ECOWITT_APP_KEY, ECOWITT_API_KEY, ECOWITT_MAC,
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

const SB = {
  headers: {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  },
};

// ── derived-metric helpers (mirror the app) ──
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
function dewPoint(t, h) {
  if (t == null || h == null) return null;
  const a = 17.27, b = 237.7, al = ((a * t) / (b + t)) + Math.log(h / 100);
  return (b * al) / (a - al);
}
function feelsLike(t, h, wKmh) {
  if (t == null || h == null) return t;
  const e = (h / 100) * 6.105 * Math.exp((17.27 * t) / (237.7 + t));
  return t + 0.33 * e - 0.70 * ((wKmh || 0) / 3.6) - 4;
}

async function getLocations() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/locations?select=*`, SB);
  if (!r.ok) throw new Error(`locations fetch ${r.status}: ${await r.text()}`);
  return r.json();
}

// All users' stations (service key bypasses owner-only RLS — cron has no session).
async function getUserStations() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/user_stations?select=station_key,provider,name,app_key,api_key,mac`, SB);
  if (!r.ok) { console.error(`user_stations fetch ${r.status}`); return []; }
  return r.json();
}

async function readEcowitt(creds) {
  if (!creds || !creds.app_key || !creds.api_key || !creds.mac) {
    throw new Error('Ecowitt creds not set');
  }
  const u = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${creds.app_key}`
    + `&api_key=${creds.api_key}&mac=${creds.mac}&call_back=all`
    + `&temp_unitid=1&pressure_unitid=3&wind_speed_unitid=7&rainfall_unitid=12&solar_irradiance_unitid=16`;
  const j = await (await fetch(u)).json();
  if (j.code !== 0) throw new Error(`Ecowitt: ${j.msg}`);
  const d = j.data, val = (o) => num(o?.value);
  const rp = d.rainfall_piezo || d.rainfall || {};
  const vpdInHg = val(d.outdoor?.vpd);
  return {
    source: 'ecowitt',
    temp: val(d.outdoor?.temperature),
    feels_like: val(d.outdoor?.feels_like) ?? val(d.outdoor?.app_temp),
    humidity: val(d.outdoor?.humidity),
    dew_point: val(d.outdoor?.dew_point),
    pressure: val(d.pressure?.relative),
    pressure_abs: val(d.pressure?.absolute),
    wind_speed: val(d.wind?.wind_speed),
    wind_gust: val(d.wind?.wind_gust),
    wind_dir: val(d.wind?.wind_direction),
    uv: val(d.solar_and_uvi?.uvi),
    solar: val(d.solar_and_uvi?.solar),
    rain_rate: num(rp.rain_rate?.value),
    rain_daily: num(rp.daily?.value),
    indoor_temp: val(d.indoor?.temperature),
    indoor_humidity: val(d.indoor?.humidity),
    soil_moisture: num(d.soil_ch1?.soilmoisture?.value),
    vpd: vpdInHg == null ? null : vpdInHg * 3.386389,
    battery: val(d.battery?.haptic_array_battery),
    weathercode: null,
    raw: d,
  };
}

async function readOpenMeteo(loc) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&current=temperature_2m,relative_humidity_2m,weathercode,windspeed_10m,winddirection_10m,wind_gusts_10m,surface_pressure,uv_index&timezone=auto`;
  const j = await (await fetch(u)).json();
  const c = j.current;
  if (!c) throw new Error('open-meteo: no current');
  return {
    source: 'open-meteo',
    temp: num(c.temperature_2m),
    feels_like: feelsLike(num(c.temperature_2m), num(c.relative_humidity_2m), num(c.windspeed_10m)),
    humidity: num(c.relative_humidity_2m),
    dew_point: dewPoint(num(c.temperature_2m), num(c.relative_humidity_2m)),
    pressure: num(c.surface_pressure),
    pressure_abs: null,
    wind_speed: num(c.windspeed_10m),
    wind_gust: num(c.wind_gusts_10m),
    wind_dir: num(c.winddirection_10m),
    uv: num(c.uv_index),
    solar: null, rain_rate: null, rain_daily: null,
    indoor_temp: null, indoor_humidity: null, soil_moisture: null, vpd: null, battery: null,
    weathercode: c.weathercode ?? null,
    raw: c,
  };
}

async function insertReading(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/readings`, {
    method: 'POST',
    headers: { ...SB.headers, Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`insert ${row.location_key} ${r.status}: ${await r.text()}`);
}

const ENV_HOME_CREDS = { app_key: ECOWITT_APP_KEY, api_key: ECOWITT_API_KEY, mac: ECOWITT_MAC };

(async () => {
  const observed_at = new Date().toISOString();
  const [locs, stations] = await Promise.all([getLocations(), getUserStations()]);
  console.log(`Tracking ${locs.length} forecast locations + ${stations.length} stations`);
  let ok = 0, fail = 0;

  // Forecast locations (Open-Meteo). The legacy hard-coded 'home' row still uses
  // the env Ecowitt creds during transition; removed in the clear-down stage.
  for (const loc of locs) {
    try {
      const metrics = loc.is_home ? await readEcowitt(ENV_HOME_CREDS) : await readOpenMeteo(loc);
      await insertReading({ location_key: loc.key, observed_at, ...metrics });
      console.log(`✓ ${loc.key}: ${metrics.temp}°C`); ok++;
    } catch (e) { console.error(`✗ ${loc.key}: ${e.message}`); fail++; }
  }

  // User stations (Ecowitt) — logged under their random station_key.
  for (const st of stations) {
    try {
      const metrics = await readEcowitt({ app_key: st.app_key, api_key: st.api_key, mac: st.mac });
      await insertReading({ location_key: st.station_key, observed_at, ...metrics });
      console.log(`✓ ${st.station_key} (${st.name}): ${metrics.temp}°C`); ok++;
    } catch (e) { console.error(`✗ ${st.station_key} (${st.name}): ${e.message}`); fail++; }
  }

  console.log(`Done — ${ok} ok, ${fail} failed`);
  if (ok === 0) process.exit(1);
})();
