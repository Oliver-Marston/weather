-- ════════════════════════════════════════════════════════════════
--  Weather app — Supabase schema
--  Run this once in your Supabase project: SQL Editor → New query → paste → Run
-- ════════════════════════════════════════════════════════════════

-- ── Locations we track ──────────────────────────────────────────
create table if not exists locations (
  id          bigint generated always as identity primary key,
  key         text unique not null,
  name        text not null,
  sub         text,
  lat         double precision not null,
  lon         double precision not null,
  is_home     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ── Time-series readings ────────────────────────────────────────
create table if not exists readings (
  id              bigint generated always as identity primary key,
  location_key    text not null references locations(key) on delete cascade,
  observed_at     timestamptz not null default now(),
  source          text not null,              -- 'ecowitt' | 'open-meteo'
  temp            double precision,           -- °C
  feels_like      double precision,           -- °C
  humidity        double precision,           -- %
  dew_point       double precision,           -- °C
  pressure        double precision,           -- relative hPa
  pressure_abs    double precision,           -- absolute hPa
  wind_speed      double precision,           -- km/h
  wind_gust       double precision,           -- km/h
  wind_dir        double precision,           -- degrees
  uv              double precision,
  solar           double precision,           -- W/m²
  rain_rate       double precision,           -- mm/h
  rain_daily      double precision,           -- mm
  indoor_temp     double precision,           -- °C  (home only)
  indoor_humidity double precision,           -- %   (home only)
  soil_moisture   double precision,           -- %   (home only)
  vpd             double precision,           -- kPa (home only)
  battery         double precision,           -- V   (home only)
  weathercode     int,                        -- WMO (open-meteo only)
  raw             jsonb
);

create index if not exists readings_loc_time on readings (location_key, observed_at desc);

-- ── Seed locations (home + current favourites) ──────────────────
insert into locations (key,name,sub,lat,lon,is_home) values
  ('home','Home','Burton-on-the-Wolds · Live station',52.7868543,-1.1251226,true),
  ('loughborough','Loughborough','LE12, England',52.7722,-1.2037,false),
  ('london','London','England, UK',51.5074,-0.1278,false),
  ('vilamoura','Vilamoura','Algarve, Portugal',37.0735,-8.1219,false)
on conflict (key) do nothing;

-- ── Row Level Security ──────────────────────────────────────────
alter table locations enable row level security;
alter table readings  enable row level security;

-- Public (anon) read access for the app's charts
create policy "public read locations" on locations for select using (true);
create policy "public read readings"  on readings  for select using (true);

-- Let the app manage its own location list with the anon key.
-- (Personal app; remove these three if you want locations locked down.)
create policy "anon insert locations" on locations for insert with check (true);
create policy "anon update locations" on locations for update using (true) with check (true);
create policy "anon delete locations" on locations for delete using (true);

-- NOTE: readings are inserted by the GitHub Action using the service_role
-- key, which bypasses RLS — so there is intentionally no anon write policy
-- on readings (nobody can forge data with the public key).
