// Supabase: cloud backup of SAFE data + storage for cleaned evidence photos.
//
// Local SQLite stays the source of truth, so the app works fully offline.
// Everything bound for the cloud goes into the cloud_outbox table first and a
// background worker pushes it with retries and back-off. Zero dependencies:
// Supabase's REST (PostgREST) and Storage APIs are called with plain fetch.
//
// What NEVER goes to Supabase: callsigns, phone hashes, PIN hashes, device
// hashes, sessions, raw narratives, exact coordinates, the link between a
// report and the agent who filed it, and original (un-stripped) photos.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db, MEDIA_DIR } from './db.mjs';

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.SUPABASE_BUCKET || 'evidence';
export const CLOUD_ENABLED = Boolean(URL_ && KEY);

const state = { last_ok: null, last_error: null };

function headers(extra = {}) {
  const h = { apikey: KEY, ...extra };
  // Legacy service_role keys are JWTs and go in Authorization too; the newer
  // sb_secret_ keys are sent in the apikey header only.
  if (KEY.startsWith('eyJ')) h.authorization = `Bearer ${KEY}`;
  return h;
}

// ── queueing (always on, so nothing is lost if Supabase is added later) ─────

/** Queue an upsert. Older pending copies of the same row are dropped first. */
export function queueRow(table, row, key = 'id') {
  const target = `${table}:${row[key]}`;
  db.prepare(`DELETE FROM cloud_outbox WHERE kind = 'row' AND target = ? AND done_at IS NULL`).run(target);
  db.prepare(`INSERT INTO cloud_outbox (kind, target, payload) VALUES ('row', ?, ?)`)
    .run(target, JSON.stringify({ key, row }));
}

export function queuePhoto(objectPath, localName) {
  db.prepare(`INSERT INTO cloud_outbox (kind, target, payload) VALUES ('photo', ?, ?)`)
    .run(objectPath, localName);
}

// ── pushing ────────────────────────────────────────────────────────────────

async function pushRow(target, payload) {
  const table = target.slice(0, target.indexOf(':'));
  const { key, row } = JSON.parse(payload);
  const r = await fetch(`${URL_}/rest/v1/${table}?on_conflict=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: headers({
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=minimal',
    }),
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`${table} upsert ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function pushPhoto(objectPath, localName) {
  const buf = await readFile(join(MEDIA_DIR, localName));
  const r = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: headers({
      'content-type': localName.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'x-upsert': 'true',
    }),
    body: buf,
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`photo upload ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

let running = false;
async function flush() {
  if (running || !CLOUD_ENABLED) return;
  running = true;
  try {
    const jobs = db.prepare(`SELECT * FROM cloud_outbox WHERE done_at IS NULL
                              AND next_try_at <= datetime('now') ORDER BY id LIMIT 25`).all();
    for (const job of jobs) {
      try {
        if (job.kind === 'photo') await pushPhoto(job.target, job.payload);
        else await pushRow(job.target, job.payload);
        db.prepare(`UPDATE cloud_outbox SET done_at = datetime('now'), last_error = NULL WHERE id = ?`).run(job.id);
        state.last_ok = new Date().toISOString();
      } catch (err) {
        const wait = Math.min(3600, 10 * 2 ** job.attempts); // 10s, 20s, 40s … capped at 1h
        db.prepare(`UPDATE cloud_outbox SET attempts = attempts + 1, last_error = ?,
                    next_try_at = datetime('now', ?) WHERE id = ?`).run(String(err.message), `+${wait} seconds`, job.id);
        state.last_error = err.message;
        // Network down (offline laptop): stop this round instead of failing every job.
        if (err.name === 'TimeoutError' || /fetch failed/i.test(err.message)) break;
      }
    }
    db.prepare(`DELETE FROM cloud_outbox WHERE done_at < datetime('now', '-7 days')`).run();
  } finally {
    running = false;
  }
}

export function startCloudSync() {
  if (!CLOUD_ENABLED) return;
  setInterval(() => flush().catch(() => {}), 5000).unref();
  flush().catch(() => {});
}

export function cloudStatus() {
  const q = db.prepare(`SELECT COUNT(*) AS pending, MAX(attempts) AS max_attempts
                          FROM cloud_outbox WHERE done_at IS NULL`).get();
  return {
    enabled: CLOUD_ENABLED, bucket: CLOUD_ENABLED ? BUCKET : null,
    pending: q.pending, failing: (q.max_attempts || 0) > 0,
    last_ok: state.last_ok, last_error: state.last_error,
  };
}
