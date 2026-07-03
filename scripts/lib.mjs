// ════════════════════════════════════════════════════════════════
//  Shared helpers for the ingestion/backfill scripts.
//  Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
// ════════════════════════════════════════════════════════════════

export const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

export function requireEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing env: SUPABASE_URL / SUPABASE_SERVICE_KEY');
    process.exit(1);
  }
}

export const SB = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// ── numeric / derived-metric helpers (mirror the app) ──
export const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
export function dewPoint(t, h) {
  if (t == null || h == null) return null;
  const a = 17.27, b = 237.7, al = ((a * t) / (b + t)) + Math.log(h / 100);
  return (b * al) / (a - al);
}
export function feelsLike(t, h, wKmh) {
  if (t == null || h == null) return t;
  const e = (h / 100) * 6.105 * Math.exp((17.27 * t) / (237.7 + t));
  return t + 0.33 * e - 0.70 * ((wKmh || 0) / 3.6) - 4;
}
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Supabase access ──

// The set of locations to log = the union of every user's favourites.
// We upsert their metadata into the shared `locations` table (registry +
// shared-history cache), then return the distinct list. Locations no user
// has any more simply stop being logged; their history stays as cache.
export async function getActiveLocations() {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_locations?select=location_key,name,sub,lat,lon&order=created_at`,
    { headers: SB },
  );
  if (!r.ok) throw new Error(`user_locations fetch ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  const byKey = new Map();
  for (const row of rows) {
    if (!byKey.has(row.location_key)) {
      byKey.set(row.location_key, {
        key: row.location_key, name: row.name, sub: row.sub ?? null,
        lat: row.lat, lon: row.lon, is_home: false,
      });
    }
  }
  const locs = [...byKey.values()];
  if (locs.length) {
    const up = await fetch(`${SUPABASE_URL}/rest/v1/locations?on_conflict=key`, {
      method: 'POST',
      headers: { ...SB, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(locs),
    });
    if (!up.ok) console.error(`locations upsert ${up.status}: ${await up.text()}`);
  }
  return locs;
}

// All users' stations (service key bypasses owner-only RLS — cron has no session).
export async function getUserStations() {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_stations?select=station_key,provider,name,app_key,api_key,mac`,
    { headers: SB },
  );
  if (!r.ok) { console.error(`user_stations fetch ${r.status}`); return []; }
  return r.json();
}

export async function hasReadings(key) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/readings?location_key=eq.${encodeURIComponent(key)}&select=id&limit=1`,
    { headers: SB },
  );
  const d = await r.json();
  return Array.isArray(d) && d.length > 0;
}

export async function insertReading(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/readings`, {
    method: 'POST',
    headers: { ...SB, Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`insert ${row.location_key} ${r.status}: ${await r.text()}`);
}

export async function bulkInsert(rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/readings`, {
      method: 'POST',
      headers: { ...SB, Prefer: 'return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) throw new Error(`insert ${r.status}: ${await r.text()}`);
    n += chunk.length;
  }
  return n;
}

// ── weather sources ──

const ECOWITT_UNITS = '&temp_unitid=1&pressure_unitid=3&wind_speed_unitid=7&rainfall_unitid=12&solar_irradiance_unitid=16';
const encCreds = (c) =>
  `application_key=${encodeURIComponent(c.app_key)}&api_key=${encodeURIComponent(c.api_key)}&mac=${encodeURIComponent(c.mac)}`;

// Live snapshot from an Ecowitt station.
export async function readEcowitt(creds) {
  if (!creds?.app_key || !creds?.api_key || !creds?.mac) throw new Error('Ecowitt creds not set');
  const u = `https://api.ecowitt.net/api/v3/device/real_time?${encCreds(creds)}&call_back=all${ECOWITT_UNITS}`;
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

// Current conditions for a forecast location (Open-Meteo).
export async function readOpenMeteo(loc) {
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

// Recent per-day 30-min history for an Ecowitt station (free-tier depth is shallow).
export async function ecowittHistory(creds, station_key, days = 30) {
  const rows = [], now = Date.now();
  for (let d = days; d >= 0; d--) {
    const dt = new Date(now - d * 86400000);
    const u = `https://api.ecowitt.net/api/v3/device/history?${encCreds(creds)}`
      + `&start_date=${ymd(dt)}%2000:00:00&end_date=${ymd(dt)}%2023:59:59&cycle_type=30min`
      + `&call_back=outdoor,wind,pressure,solar_and_uvi,rainfall_piezo,indoor,soil_ch1${ECOWITT_UNITS}`;
    let j; try { j = await (await fetch(u)).json(); } catch { await sleep(300); continue; }
    if (j.code !== 0) { await sleep(300); continue; }
    const cats = j.data || {}, tempList = cats.outdoor?.temperature?.list || {};
    const g = (cat, f, t) => num(cats?.[cat]?.[f]?.list?.[t]);
    for (const t of Object.keys(tempList)) {
      const vpd = g('outdoor', 'vpd', t);
      rows.push({
        location_key: station_key, observed_at: new Date(+t * 1000).toISOString(), source: 'ecowitt',
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
    await sleep(300);
  }
  return rows;
}
