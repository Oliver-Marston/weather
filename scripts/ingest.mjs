// ════════════════════════════════════════════════════════════════
//  Weather ingestion — runs in GitHub Actions on a schedule.
//  Logs a current reading for every active forecast location (the
//  union of all users' favourites, via Open-Meteo) and for every
//  user station (via Ecowitt, using the creds stored per-station).
//
//  Required env (GitHub repository secrets):
//    SUPABASE_URL, SUPABASE_SERVICE_KEY
// ════════════════════════════════════════════════════════════════

import {
  requireEnv, getActiveLocations, getUserStations,
  readEcowitt, readOpenMeteo, insertReading,
} from './lib.mjs';

requireEnv();

(async () => {
  const observed_at = new Date().toISOString();
  const [locs, stations] = await Promise.all([getActiveLocations(), getUserStations()]);
  console.log(`Tracking ${locs.length} forecast locations + ${stations.length} stations`);
  let ok = 0, fail = 0;

  for (const loc of locs) {
    try {
      const metrics = await readOpenMeteo(loc);
      await insertReading({ location_key: loc.key, observed_at, ...metrics });
      console.log(`✓ ${loc.key}: ${metrics.temp}°C`); ok++;
    } catch (e) { console.error(`✗ ${loc.key}: ${e.message}`); fail++; }
  }

  for (const st of stations) {
    try {
      const metrics = await readEcowitt({ app_key: st.app_key, api_key: st.api_key, mac: st.mac });
      await insertReading({ location_key: st.station_key, observed_at, ...metrics });
      console.log(`✓ ${st.station_key} (${st.name}): ${metrics.temp}°C`); ok++;
    } catch (e) { console.error(`✗ ${st.station_key} (${st.name}): ${e.message}`); fail++; }
  }

  console.log(`Done — ${ok} ok, ${fail} failed`);
  // Only fail the run when there was work and ALL of it failed
  // (zero users/locations is a legitimate empty run, not an error).
  if (fail > 0 && ok === 0) process.exit(1);
})();
