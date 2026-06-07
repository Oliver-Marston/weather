// ════════════════════════════════════════════════════════════════
//  One-off: extend saved-location history to 12 months using the
//  Open-Meteo ARCHIVE (ERA5) API. Fills 365→91 days ago; the most
//  recent ~90 days are already present from the forecast backfill.
//  Run locally:  node scripts/backfill-archive.mjs
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

async function backfill(loc) {
  const now = Date.now();
  const start = ymd(new Date(now - 365 * 86400000));
  const end = ymd(new Date(now - 91 * 86400000));
  const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&start_date=${start}&end_date=${end}`
    + `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code&timezone=GMT`;
  const j = await (await fetch(u)).json();
  const h = j.hourly; if (!h?.time) { console.log(`· ${loc.key}: no data (${j.reason || ''})`); return; }
  const rows = [];
  for (let i = 0; i < h.time.length; i++) {
    const temp = num(h.temperature_2m[i]); if (temp == null) continue;
    const hum = num(h.relative_humidity_2m[i]), wind = num(h.wind_speed_10m[i]);
    rows.push({
      location_key: loc.key, observed_at: `${h.time[i]}:00Z`, source: 'open-meteo-archive',
      temp, feels_like: feelsLike(temp, hum, wind), humidity: hum,
      dew_point: num(h.dew_point_2m[i]) ?? dewPoint(temp, hum),
      pressure: num(h.surface_pressure[i]),
      wind_speed: wind, wind_gust: num(h.wind_gusts_10m[i]), wind_dir: num(h.wind_direction_10m[i]),
      uv: null, weathercode: h.weather_code[i] ?? null,
    });
  }
  const n = await bulkInsert(rows);
  console.log(`✓ ${loc.key}: ${n} rows (${start} → ${end})`);
}

(async () => {
  const locs = (await getLocations()).filter(l => !l.is_home);
  for (const loc of locs) { await backfill(loc); await sleep(300); }
  console.log('12-month archive backfill complete');
})();
