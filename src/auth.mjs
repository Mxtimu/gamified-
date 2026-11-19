// Player profiles: registration, PIN login, cookie sessions, and the
// "one profile per person" rule (one per phone number AND one per device).
//
// Privacy rules this file keeps:
//  - The phone number is normalised, HMAC'd with a server key, and dropped.
//    It is never stored, logged, returned, or placed in any outbound payload.
//  - The device token and session token live only in HttpOnly cookies; the
//    database stores SHA-256 hashes of them.
//  - PINs are stored with scrypt + a per-profile salt.
import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.mjs';

const PHONE_SECRET = process.env.PHONE_SECRET || 'ghost-puppy-dev-phone-key-do-not-ship';
const SESSION_DAYS = 30;
const DEVICE_COOKIE = 'gp_device';
const SESSION_COOKIE = 'gp_session';

export const AVATARS = ['🐶', '👻', '🦊', '🐺', '🦉', '🐱', '🦁', '🐼'];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ── phone ──────────────────────────────────────────────────────────────────

/** SA cellphone → 10-digit local form (0XXXXXXXXX), or null if it isn't one. */
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('27') && d.length === 11) d = '0' + d.slice(2);
  return /^0[6-8]\d{8}$/.test(d) ? d : null;
}

export const phoneHash = (normalised) =>
  createHmac('sha256', PHONE_SECRET).update('phone:' + normalised).digest('hex');

// ── PIN ────────────────────────────────────────────────────────────────────

export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(String(pin), salt, 32).toString('hex')}`;
}

export function checkPin(pin, stored) {
  if (!stored) return false;
  const [salt, hex] = stored.split(':');
  const want = Buffer.from(hex, 'hex');
  const got = scryptSync(String(pin), salt, 32);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ── cookies ────────────────────────────────────────────────────────────────

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function addCookie(res, name, value, maxAgeSec) {
  const prev = res.getHeader('set-cookie') || [];
  res.setHeader('set-cookie', [...[].concat(prev),
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`]);
}

/** Returns this browser's device token, issuing a long-lived one if it has none. */
export function ensureDevice(req, res) {
  let token = parseCookies(req)[DEVICE_COOKIE];
  if (!token || !/^[\w-]{20,}$/.test(token)) {
    token = randomBytes(24).toString('base64url');
    addCookie(res, DEVICE_COOKIE, token, 10 * 365 * 24 * 3600);
  }
  return sha256('device:' + token);
}

// ── sessions ───────────────────────────────────────────────────────────────

export function startSession(res, agentId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (token_hash, agent_id, expires_at)
              VALUES (?, ?, datetime('now', ?))`).run(sha256(token), agentId, `+${SESSION_DAYS} days`);
  addCookie(res, SESSION_COOKIE, token, SESSION_DAYS * 24 * 3600);
}

export function endSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  addCookie(res, SESSION_COOKIE, '', 0);
}

/** The logged-in agent row for this request, or null. */
export function sessionAgent(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return db.prepare(`SELECT a.* FROM sessions s JOIN agents a ON a.id = s.agent_id
                      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).get(sha256(token)) || null;
}

export function requireAgent(req) {
  const a = sessionAgent(req);
  if (!a) throw httpError(401, 'Log in or create a profile first.');
  return a;
}

// ── rate limits (in memory; reset on restart) ──────────────────────────────
// Registration is limited per IP because the "phone already has a profile"
// answer would otherwise let someone test whether a number belongs to a player.
// Login is limited per callsign so 4-digit PINs can't be brute-forced.
const buckets = new Map();
export function rateLimit(key, max, windowMs, message) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return; }
  if (++b.n > max) {
    const mins = Math.ceil((b.reset - now) / 60000);
    throw httpError(429, `${message} Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
}
export const clearRateLimit = (key) => buckets.delete(key);

// ── staff: admin portal + City Power / SAPS partner portal ─────────────────
// Two roles, each unlocked by one password from .env. A role whose password is
// missing or shorter than 10 characters is switched off, so a fresh install
// never exposes the portals with a guessable default.
//   admin   — everything in /admin.html
//   partner — /partner.html only: blurred, anonymous reports + verify/reject
const STAFF_COOKIE = 'gp_staff';
const STAFF_HOURS = 12;
export const STAFF_MIN_PASSWORD = 10;

db.exec(`
CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'partner')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
`);

const staffPassword = (role) =>
  String((role === 'admin' ? process.env.ADMIN_PASSWORD : process.env.PARTNER_PASSWORD) || '');
export const staffEnabled = (role) => staffPassword(role).length >= STAFF_MIN_PASSWORD;

/** Constant-time compare (hashing first makes the lengths equal). */
const samePassword = (given, expected) =>
  timingSafeEqual(createHash('sha256').update(String(given)).digest(),
    createHash('sha256').update(expected).digest());

export function staffLogin(res, role, password) {
  if (role !== 'admin' && role !== 'partner') throw httpError(400, 'Unknown portal.');
  if (!staffEnabled(role)) {
    throw httpError(503, `The ${role} portal is switched off. Set ${role === 'admin' ? 'ADMIN_PASSWORD' : 'PARTNER_PASSWORD'} (at least ${STAFF_MIN_PASSWORD} characters) in .env and restart.`);
  }
  if (!samePassword(password, staffPassword(role))) throw httpError(401, 'Wrong password.');
  db.prepare(`DELETE FROM staff_sessions WHERE expires_at <= datetime('now')`).run();
  const token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO staff_sessions (token_hash, role, expires_at)
              VALUES (?, ?, datetime('now', ?))`).run(sha256(token), role, `+${STAFF_HOURS} hours`);
  addCookie(res, STAFF_COOKIE, token, STAFF_HOURS * 3600);
}

export function staffLogout(req, res) {
  const token = parseCookies(req)[STAFF_COOKIE];
  if (token) db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?').run(sha256(token));
  addCookie(res, STAFF_COOKIE, '', 0);
}

/** 'admin' | 'partner' | null. A role switched off in .env stops working at once. */
export function staffRole(req) {
  const token = parseCookies(req)[STAFF_COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT role FROM staff_sessions
                           WHERE token_hash = ? AND expires_at > datetime('now')`).get(sha256(token));
  return row && staffEnabled(row.role) ? row.role : null;
}

/** Admin can do everything a partner can. */
export function requireStaff(req, role) {
  const have = staffRole(req);
  if (!have) throw httpError(401, 'Log in to the portal first.');
  if (role === 'admin' && have !== 'admin') throw httpError(403, 'Admins only.');
  return have;
}
