// Relational store for the Msotra virtual economy + geospatial zone queries.
// Uses Node's built-in SQLite (node:sqlite) so the lab runs with zero npm installs.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const MEDIA_DIR = join(DATA_DIR, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'msotra.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
-- Map: fictionalised Soweto operational zones
CREATE TABLE IF NOT EXISTS zones (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  crew        TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  landmark    TEXT NOT NULL,
  grid_health INTEGER NOT NULL DEFAULT 100 CHECK (grid_health BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS idx_zones_geo ON zones(lat, lng);

-- Agents: pseudonymous only. No names, no phone numbers, ever.
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY,
  callsign      TEXT NOT NULL UNIQUE,
  ghost_id      TEXT NOT NULL UNIQUE,
  rank          TEXT NOT NULL DEFAULT 'Observer',
  xp            INTEGER NOT NULL DEFAULT 0,
  coin_balance  INTEGER NOT NULL DEFAULT 0 CHECK (coin_balance >= 0),
  home_zone_id  INTEGER REFERENCES zones(id),
  ghost_mode    INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reports: the raw intel drop (raw copy never leaves this table)
CREATE TABLE IF NOT EXISTS reports (
  id             INTEGER PRIMARY KEY,
  ref            TEXT NOT NULL UNIQUE,
  agent_id       INTEGER NOT NULL REFERENCES agents(id),
  zone_id        INTEGER NOT NULL REFERENCES zones(id),
  category       TEXT NOT NULL,
  severity       INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  narrative_raw  TEXT NOT NULL,
  narrative_safe TEXT NOT NULL,
  lat_exact      REAL NOT NULL,
  lng_exact      REAL NOT NULL,
  lat_fuzzed     REAL NOT NULL,
  lng_fuzzed     REAL NOT NULL,
  status         TEXT NOT NULL DEFAULT 'submitted',
  coins_awarded  INTEGER NOT NULL DEFAULT 0,
  verified_by    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_zone  ON reports(zone_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_agent ON reports(agent_id, created_at);

-- Paparazzi quest media: stored only after metadata is destroyed
CREATE TABLE IF NOT EXISTS report_media (
  id             INTEGER PRIMARY KEY,
  report_id      INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  stored_name    TEXT NOT NULL,
  mime           TEXT NOT NULL,
  bytes_in       INTEGER NOT NULL,
  bytes_out      INTEGER NOT NULL,
  chunks_removed TEXT NOT NULL,
  sha256_safe    TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Kasi Intel chat transcript (WhatsApp-style dialogue)
CREATE TABLE IF NOT EXISTS intel_messages (
  id         INTEGER PRIMARY KEY,
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only coin ledger. Balance is always derivable from here.
CREATE TABLE IF NOT EXISTS ledger (
  id            INTEGER PRIMARY KEY,
  agent_id      INTEGER NOT NULL REFERENCES agents(id),
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  report_id     INTEGER REFERENCES reports(id),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_agent ON ledger(agent_id, id);

-- Real-world redemption gateway
CREATE TABLE IF NOT EXISTS redemptions (
  id           INTEGER PRIMARY KEY,
  agent_id     INTEGER NOT NULL REFERENCES agents(id),
  sku          TEXT NOT NULL,
  label        TEXT NOT NULL,
  cost         INTEGER NOT NULL,
  voucher_code TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'issued',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ghost Agent audit trail: proof of what we destroyed, per report
CREATE TABLE IF NOT EXISTS sanitization_log (
  id         INTEGER PRIMARY KEY,
  report_id  INTEGER REFERENCES reports(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,
  rule       TEXT NOT NULL,
  field      TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sanlog_report ON sanitization_log(report_id);

-- Municipal webhook outbox: exactly what left the building
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id           INTEGER PRIMARY KEY,
  report_id    INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Blackout Escape Room sessions (live event module)
CREATE TABLE IF NOT EXISTS escape_sessions (
  id           INTEGER PRIMARY KEY,
  team_name    TEXT NOT NULL,
  zone_id      INTEGER REFERENCES zones(id),
  clues_found  INTEGER NOT NULL DEFAULT 0,
  solved       INTEGER NOT NULL DEFAULT 0,
  seconds_left INTEGER NOT NULL DEFAULT 300,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at     TEXT
);
`);

const ZONES = [
  ['Orlando West',   'Orlando Crew',     -26.2385, 27.9056, 'Vilakazi Street'],
  ['Orlando East',   'Orlando Crew',     -26.2489, 27.9270, 'Orlando Stadium'],
  ['Diepkloof',      'Diepkloof Crew',   -26.2500, 27.9500, 'Diepkloof Hostel'],
  ['Jabulani',       'Central Crew',     -26.2564, 27.8640, 'Jabulani Mall'],
  ['Klipspruit',     'Central Crew',     -26.2647, 27.8878, 'Maponya Mall'],
  ['Meadowlands',    'Meadowlands Crew', -26.2170, 27.8780, 'Meadowlands Zone 9'],
  ['Pimville',       'Pimville Crew',    -26.2760, 27.8990, 'Pimville Zone 6'],
  ['Dobsonville',    'Dobsonville Crew', -26.2280, 27.8390, 'Dobsonville Centre'],
  ['Zola',           'Deep West Crew',   -26.2480, 27.8420, 'Zola Taxi Rank'],
  ['Naledi',         'Deep West Crew',   -26.2610, 27.8330, 'Naledi Hall'],
  ['Emdeni',         'Deep West Crew',   -26.2400, 27.8290, 'Emdeni Square'],
  ['Protea Glen',    'Protea Crew',      -26.2790, 27.8090, 'Protea Glen Ext 12'],
];

if (db.prepare('SELECT COUNT(*) AS n FROM zones').get().n === 0) {
  const ins = db.prepare(
    'INSERT INTO zones (name, crew, lat, lng, landmark, grid_health) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const [name, crew, lat, lng, landmark] of ZONES) {
    ins.run(name, crew, lat, lng, landmark, 70 + Math.floor(Math.random() * 30));
  }
}

/** Great-circle distance in metres. */
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Nearest operational zone to a dropped map pin. */
export function nearestZone(lat, lng) {
  const zones = db.prepare('SELECT * FROM zones').all();
  let best = null;
  let bestD = Infinity;
  for (const z of zones) {
    const d = haversine(lat, lng, z.lat, z.lng);
    if (d < bestD) { bestD = d; best = z; }
  }
  return { zone: best, distance_m: Math.round(bestD) };
}

export function logSanitization(reportId, stage, rule, field, hits = 1) {
  db.prepare(
    'INSERT INTO sanitization_log (report_id, stage, rule, field, hits) VALUES (?, ?, ?, ?, ?)'
  ).run(reportId, stage, rule, field, hits);
}
