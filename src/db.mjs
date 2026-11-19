// Relational store for the Msotra virtual economy + geospatial zone queries.
// Uses Node's built-in SQLite (node:sqlite) so the lab runs with zero npm installs.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOWNSHIPS } from './townships.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const MEDIA_DIR = join(DATA_DIR, 'media');
mkdirSync(MEDIA_DIR, { recursive: true });

// DB_FILE lets tests and demos run against a throwaway database.
export const db = new DatabaseSync(process.env.DB_FILE || join(DATA_DIR, 'msotra.db'));
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

-- Agents: pseudonymous only. No names, and no readable phone numbers, ever
-- (see the profile migration below: only a keyed hash of the phone is kept).
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

// ── Townships and their parts (see src/townships.mjs) ─────────────────────
// zones = townships. sections = the extensions / zones / phases inside one.
// Upserted by name on every start, so editing townships.mjs and restarting is
// enough. Existing ids and grid health are kept: agents and reports point at them.
db.exec(`
CREATE TABLE IF NOT EXISTS sections (
  id      INTEGER PRIMARY KEY,
  zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (zone_id, name)
);
`);
{
  const insZone = db.prepare(`INSERT INTO zones (name, crew, lat, lng, landmark, grid_health)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET crew = excluded.crew, lat = excluded.lat,
      lng = excluded.lng, landmark = excluded.landmark
    RETURNING id`);
  const insSection = db.prepare(`INSERT INTO sections (zone_id, name, sort) VALUES (?, ?, ?)
    ON CONFLICT(zone_id, name) DO UPDATE SET sort = excluded.sort`);
  db.exec('BEGIN');
  for (const t of TOWNSHIPS) {
    const { id } = insZone.get(t.name, t.crew, t.lat, t.lng, t.landmark, 70 + Math.floor(Math.random() * 30));
    t.sections.forEach((name, i) => insSection.run(id, name, i));
  }
  db.exec('COMMIT');
}

// ── Profiles (added later — migrate existing databases in place) ───────────
// One profile per person is enforced two ways, both without storing anything
// readable: phone_hash is a keyed HMAC of the normalised cellphone number (the
// number itself is never written anywhere), device_hash is a hash of a random
// per-browser token. Partial unique indexes let older pre-profile rows keep NULLs.
const agentCols = new Set(db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name));
for (const [col, type] of [
  ['phone_hash', 'TEXT'], ['device_hash', 'TEXT'], ['pin_hash', 'TEXT'], ['avatar', "TEXT NOT NULL DEFAULT '🐶'"],
]) {
  if (!agentCols.has(col)) db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${type}`);
}

// Reports remember which part of the township (extension / zone) was chosen.
if (!db.prepare('PRAGMA table_info(reports)').all().some((c) => c.name === 'section_id')) {
  db.exec('ALTER TABLE reports ADD COLUMN section_id INTEGER REFERENCES sections(id)');
}
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_phone  ON agents(phone_hash)  WHERE phone_hash  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_device ON agents(device_hash) WHERE device_hash IS NOT NULL;

-- Login sessions: only a hash of the cookie token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);

-- Agent Net: agents talking about each other's reports. Only the scrubbed text
-- is ever stored; authors are shown by a per-thread alias, never a handle.
CREATE TABLE IF NOT EXISTS report_comments (
  id         INTEGER PRIMARY KEY,
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  alias      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_report ON report_comments(report_id, id);

CREATE TABLE IF NOT EXISTS report_reactions (
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (report_id, agent_id, kind)
);

-- Supabase sync queue. Anything that should reach the cloud is written here
-- first, so the app keeps working offline and catches up when it can.
CREATE TABLE IF NOT EXISTS cloud_outbox (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,          -- 'row' | 'photo'
  target      TEXT NOT NULL,          -- table name, or storage object path
  payload     TEXT NOT NULL,          -- JSON row, or local media file name
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  next_try_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON cloud_outbox(done_at, next_try_at);
`);

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

/** How far a pin may sit from a chosen township's centre and still count as in it. */
export const TOWNSHIP_PIN_RADIUS_M = 4000;

/**
 * Which township and part a report belongs to. The reporter's choice wins when
 * the pin is plausibly inside that township; otherwise the nearest township to
 * the pin is used (and the part is dropped, since it belonged to another one).
 */
export function resolveArea(lat, lng, zoneId, sectionId) {
  const nearest = nearestZone(lat, lng);
  const chosen = Number.isInteger(zoneId) ? db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId) : null;
  const useChosen = chosen && haversine(lat, lng, chosen.lat, chosen.lng) <= TOWNSHIP_PIN_RADIUS_M;
  const zone = useChosen ? chosen : nearest.zone;
  const section = useChosen && Number.isInteger(sectionId)
    ? db.prepare('SELECT * FROM sections WHERE id = ? AND zone_id = ?').get(sectionId, zone.id) || null
    : null;
  return { zone, section, distance_m: Math.round(haversine(lat, lng, zone.lat, zone.lng)) };
}

export function logSanitization(reportId, stage, rule, field, hits = 1) {
  db.prepare(
    'INSERT INTO sanitization_log (report_id, stage, rule, field, hits) VALUES (?, ?, ?, ?, ?)'
  ).run(reportId, stage, rule, field, hits);
}
