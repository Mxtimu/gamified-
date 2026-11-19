// ═══════════════════════════════════════════════════════════════════════════
//  GHOST PUPPY GAME STUDIO — "Spaza Defense & Grid Guardians"
//  Zero-dependency Node server: static frontend + civic-reporting API +
//  Ghost Agent sanitisation boundary + Msotra Coin economy.
// ═══════════════════════════════════════════════════════════════════════════
import './src/preflight.mjs'; // must run before node:sqlite is imported
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, DATA_DIR, MEDIA_DIR, resolveArea, logSanitization } from './src/db.mjs';
import {
  ghostId, caseRef, scrubText, fuzzGeo, fuzzTimestamp, threadAlias,
  stripImageMetadata, sha256, buildMunicipalPayload, assertNoLeak, assertGeoBlurred,
  MUNICIPAL_ALLOWLIST,
} from './src/ghost.mjs';
import {
  RANKS, rankFor, quoteReward, creditAgent, awardXp, CATALOGUE, redeem,
  crewLeaderboard, zoneLeaderboard, agentLeaderboard, hotZonesNear,
} from './src/economy.mjs';
import {
  AVATARS, normalizePhone, phoneHash, hashPin, checkPin, ensureDevice, startSession,
  endSession, sessionAgent, requireAgent, rateLimit, clearRateLimit, httpError,
} from './src/auth.mjs';
import { CLOUD_ENABLED, queueRow, queuePhoto, startCloudSync, cloudStatus } from './src/supabase.mjs';
import { staffRoutes, tileStats } from './src/staff.mjs';
import { staffRole } from './src/auth.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = process.env.PORT || 7788;
const MAX_BODY = 14 * 1024 * 1024;

// ── plumbing ───────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const json = (res, code, data) => {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Request body must be valid JSON.'); }
}

// Live event stream powering the Hood Leaderboard + intel feed.
const streams = new Set();
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) {
    try { res.write(frame); } catch { streams.delete(res); }
  }
}

// ── agents ─────────────────────────────────────────────────────────────────

const CALLSIGN_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const PIN_RE = /^\d{4,8}$/;
const clientIp = (req) => req.socket.remoteAddress || 'unknown';

function validZoneId(id) {
  const n = Number(id);
  return Number.isInteger(n) && db.prepare('SELECT 1 FROM zones WHERE id = ?').get(n) ? n : null;
}

/**
 * Creates a profile. One per person: the phone number (kept only as a keyed
 * hash) and this browser's device token must both be unused.
 */
function registerAgent(req, res, body) {
  // 30/hour: loose enough for a room of people on one community-centre
  // connection, tight enough to make probing phone numbers slow.
  rateLimit(`register:${clientIp(req)}`, 30, 60 * 60 * 1000, 'Too many sign-up attempts from this connection.');

  const callsign = String(body.callsign || '').trim();
  if (!CALLSIGN_RE.test(callsign)) {
    throw httpError(400, 'Callsign must be 3–24 letters, numbers, dots, dashes or underscores. No real names.');
  }
  const phone = normalizePhone(body.phone);
  if (!phone) throw httpError(400, 'Enter a South African cellphone number, e.g. 082 123 4567.');
  if (!PIN_RE.test(String(body.pin || ''))) throw httpError(400, 'PIN must be 4–8 digits.');
  const avatar = AVATARS.includes(body.avatar) ? body.avatar : AVATARS[0];
  const zoneId = validZoneId(body.home_zone_id);

  const pHash = phoneHash(phone);
  const dHash = ensureDevice(req, res);
  if (db.prepare('SELECT 1 FROM agents WHERE device_hash = ?').get(dHash)) {
    throw httpError(409, 'This device already has a profile. Log in instead — each person gets one profile.');
  }
  if (db.prepare('SELECT 1 FROM agents WHERE phone_hash = ?').get(pHash)) {
    throw httpError(409, 'That phone number already has a profile. Log in instead — each person gets one profile.');
  }
  if (db.prepare('SELECT 1 FROM agents WHERE callsign = ? COLLATE NOCASE').get(callsign)) {
    throw httpError(409, 'That callsign is taken. Pick another one.');
  }

  // ghost_id is derived from a random nonce, NOT from the callsign, so the
  // pseudonym can never be brute-forced back to a chosen name.
  const gid = ghostId(callsign + ':' + Date.now() + ':' + Math.random());
  const agent = db.prepare(
    `INSERT INTO agents (callsign, ghost_id, home_zone_id, phone_hash, device_hash, pin_hash, avatar)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).get(callsign, gid, zoneId, pHash, dHash, hashPin(body.pin), avatar);
  startSession(res, agent.id);
  return agent;
}

function loginAgent(req, res, body) {
  const callsign = String(body.callsign || '').trim();
  const key = `login:${callsign.toLowerCase()}`;
  rateLimit(key, 5, 15 * 60 * 1000, 'Too many wrong PINs for this callsign.');
  const agent = db.prepare('SELECT * FROM agents WHERE callsign = ? COLLATE NOCASE').get(callsign);
  if (!agent || !checkPin(String(body.pin || ''), agent.pin_hash)) {
    throw httpError(401, 'Callsign or PIN is wrong.');
  }
  clearRateLimit(key);
  ensureDevice(req, res);
  startSession(res, agent.id);
  return agent;
}

function siteStats() {
  return db.prepare(`
    SELECT COUNT(*)                                                AS drops,
           COALESCE(SUM(CASE WHEN status = 'verified' THEN 1 END), 0) AS verified,
           COALESCE(SUM(coins_awarded), 0)                          AS coins_paid,
           (SELECT COUNT(*) FROM agents WHERE pin_hash IS NOT NULL) AS players
      FROM reports`).get();
}
const broadcastStats = () => broadcast('stats', siteStats());

function agentView(a) {
  const r = rankFor(a.xp);
  const zone = a.home_zone_id ? db.prepare('SELECT name FROM zones WHERE id = ?').get(a.home_zone_id) : null;
  const stats = db.prepare(
    `SELECT COUNT(*) AS reports,
            SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified
       FROM reports WHERE agent_id = ?`
  ).get(a.id);
  return {
    callsign: a.callsign, ghost_id: a.ghost_id, coins: a.coin_balance,
    xp: a.xp, avatar: a.avatar, home_zone_id: a.home_zone_id, home_zone: zone?.name || null,
    joined: a.created_at,
    reports: stats.reports || 0, verified: stats.verified || 0, ...r,
  };
}

// ── the reporting pipeline ─────────────────────────────────────────────────

async function submitReport(agent, body) {
  const {
    category, severity, narrative, lat, lng, zone_id, section_id,
    media = [], chat = [],
  } = body;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const e = new Error('A map pin is required — drop a coordinate first.');
    e.status = 400; throw e;
  }
  // Category is shown to other agents on Agent Net, so only known values get in.
  if (!CATEGORIES.includes(category)) throw httpError(400, 'Unknown report category.');
  const { zone, section, distance_m } = resolveArea(lat, lng, zone_id, section_id);

  // Stage 2 — scrub the free-typed narrative + chat transcript.
  const combined = [narrative, ...chat.map((m) => m.body)].filter(Boolean).join(' • ');
  const { clean: narrativeSafe, findings } = scrubText(combined);

  // Stage 3 — blur the pin.
  const geo = fuzzGeo(lat, lng);

  const report = db.prepare(`
    INSERT INTO reports
      (ref, agent_id, zone_id, section_id, category, severity, narrative_raw, narrative_safe,
       lat_exact, lng_exact, lat_fuzzed, lng_fuzzed, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')
    RETURNING *`
  ).get(
    caseRef(), agent.id, zone.id, section?.id ?? null, category, Math.min(5, Math.max(1, Number(severity) || 3)),
    combined || '(no narrative)', narrativeSafe || '(no narrative)',
    lat, lng, geo.lat_fuzzed, geo.lng_fuzzed
  );

  for (const f of findings) logSanitization(report.id, 'text', f.rule, 'narrative', f.hits);
  logSanitization(report.id, 'geo', `grid_snap_${geo.precision_m}m_displaced_${geo.displaced_m}m`, 'coordinates', 1);

  for (const m of chat) {
    const safeBody = m.author === 'agent' ? scrubText(m.body).clean : m.body;
    db.prepare('INSERT INTO intel_messages (report_id, author, body) VALUES (?, ?, ?)')
      .run(report.id, m.author === 'control' ? 'control' : 'agent', safeBody);
  }

  // Stage 4 — destroy image metadata before a single byte hits disk.
  const mediaHashes = [];
  const mediaOut = [];
  let mediaRejected = 0;
  for (const dataUrl of media.slice(0, 4)) {
    const b64 = String(dataUrl).split(',')[1] || '';
    const raw = Buffer.from(b64, 'base64');
    if (!raw.length) continue;
    const { buffer, removed, mime } = stripImageMetadata(raw);
    if (!buffer) {
      logSanitization(report.id, 'media', 'rejected_unknown_container', 'photo', 1);
      mediaRejected++;
      continue;
    }
    const hash = sha256(buffer);
    const storedName = `${report.ref}-${mediaHashes.length}.${mime === 'image/png' ? 'png' : 'jpg'}`;
    await writeFile(join(MEDIA_DIR, storedName), buffer);
    db.prepare(`
      INSERT INTO report_media
        (report_id, stored_name, mime, bytes_in, bytes_out, chunks_removed, sha256_safe)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(report.id, storedName, mime, raw.length, buffer.length, JSON.stringify(removed), hash);
    for (const r of removed) logSanitization(report.id, 'media', r, 'photo', 1);
    mediaHashes.push(hash);
    mediaOut.push({ url: `/media/${storedName}`, removed, bytes_in: raw.length, bytes_out: buffer.length });
  }

  // Stage 5 — build the outbound payload by allowlist, then trip-wire it.
  const payload = buildMunicipalPayload(report, zone, mediaHashes, section);
  // String identifiers only. narrative_raw is deliberately absent: when a report
  // contains no PII its safe copy is legitimately identical to the raw one, and
  // comparing the two would block every honest, already-clean report. Surviving
  // PII is caught by the structural sweep; the pin by assertGeoBlurred.
  const forbidden = [agent.callsign, agent.ghost_id];
  let blocked = null;
  try {
    assertNoLeak(payload, forbidden);
    assertGeoBlurred(payload, report.lat_exact, report.lng_exact);
  } catch (err) {
    blocked = err.violations || ['unknown'];
    logSanitization(report.id, 'tripwire', 'outbound_blocked', 'payload', blocked.length);
  }

  const endpoints = category === 'cable_theft' || category === 'substation_vandalism'
    ? ['city_power', 'saps'] : ['city_power'];

  if (!blocked) {
    for (const ep of endpoints) {
      db.prepare(`INSERT INTO webhook_outbox (report_id, endpoint, payload_json, status, attempts)
                  VALUES (?, ?, ?, 'sent', 1)`)
        .run(report.id, ep, JSON.stringify(payload));
    }
    db.prepare(`UPDATE reports SET status = 'forwarded' WHERE id = ?`).run(report.id);
    report.status = 'forwarded';
    logSanitization(report.id, 'payload', `allowlist_${MUNICIPAL_ALLOWLIST.length}_fields`, 'payload', 1);
  }

  db.prepare('UPDATE zones SET grid_health = MAX(0, grid_health - ?) WHERE id = ?')
    .run(report.severity * 2, zone.id);

  const quote = quoteReward(report.category, report.severity, mediaHashes.length);

  broadcast('report', { ref: report.ref, zone: zone.name, section: section?.name ?? null, crew: zone.crew,
    category: report.category, severity: report.severity, status: report.status });
  broadcast('leaderboard', { crews: crewLeaderboard() });
  broadcastStats();
  broadcast('net', { ref: report.ref }); // Agent Net: a new report to show
  syncReport(report.id); syncPhotos(report.id); syncAgent(agent.id);

  return {
    ok: true,
    report: {
      ref: report.ref, status: report.status, zone: zone.name, section: section?.name ?? null,
      crew: zone.crew, landmark: zone.landmark, pin_distance_m: distance_m,
      category: report.category, severity: report.severity,
    },
    reward_pending: quote,
    media: mediaOut,
    ghost: {
      agent_seen_by_authorities: 'anonymous (no identifier transmitted)',
      text_rules_fired: findings,
      geo: geo,
      media_metadata_destroyed: mediaOut.flatMap((m) => m.removed),
      allowlist: MUNICIPAL_ALLOWLIST,
      outbound_payload: payload,
      tripwire: blocked ? { passed: false, violations: blocked } : { passed: true },
      forwarded_to: blocked ? [] : endpoints,
    },
    media_rejected: mediaRejected,
    agent: agentView(db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id)),
  };
}

// ── Agent Net: reports shared between agents, with comments + reactions ─────

const CATEGORIES = ['cable_theft', 'substation_vandalism', 'open_chamber', 'illegal_connection', 'streetlight_out'];
const REACTIONS = ['seen', 'confirm', 'careful', 'respect']; // 👀 ✅ ⚠️ 💪
const sqlToDate = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

/** True if the outbound tripwire fired: the scrubbed text may still hold PII, so it's never shared. */
const isBlocked = (reportId) => Boolean(db.prepare(
  `SELECT 1 FROM sanitization_log WHERE report_id = ? AND stage = 'tripwire'`).get(reportId));

function reactionCounts(reportId) {
  const out = Object.fromEntries(REACTIONS.map((k) => [k, 0]));
  for (const r of db.prepare('SELECT kind, COUNT(*) AS n FROM report_reactions WHERE report_id = ? GROUP BY kind').all(reportId)) {
    out[r.kind] = r.n;
  }
  return out;
}

const commentCount = (reportId) =>
  db.prepare('SELECT COUNT(*) AS n FROM report_comments WHERE report_id = ?').get(reportId).n;

function reportWithZone(where, ...args) {
  return db.prepare(`SELECT r.*, z.name AS zone, z.crew, z.landmark, s.name AS section
                       FROM reports r JOIN zones z ON z.id = r.zone_id
                       LEFT JOIN sections s ON s.id = r.section_id WHERE ${where}`).get(...args);
}

/** What another agent may see of a report: blurred, scrubbed, no author. */
function netItem(r, me) {
  return {
    ref: r.ref, category: r.category, severity: r.severity, status: r.status,
    zone: r.zone, section: r.section, crew: r.crew, landmark: r.landmark,
    lat: r.lat_fuzzed, lng: r.lng_fuzzed, precision_m: 150,
    observed_window: fuzzTimestamp(sqlToDate(r.created_at)),
    description: isBlocked(r.id) ? null : r.narrative_safe,
    photos: db.prepare('SELECT stored_name FROM report_media WHERE report_id = ? ORDER BY id').all(r.id)
      .map((m) => `/media/${m.stored_name}`),
    reactions: reactionCounts(r.id),
    my_reactions: db.prepare('SELECT kind FROM report_reactions WHERE report_id = ? AND agent_id = ?')
      .all(r.id, me.id).map((x) => x.kind),
    comments: commentCount(r.id),
    mine: r.agent_id === me.id,
  };
}

function commentView(c, report, me) {
  return {
    id: c.id,
    author: c.agent_id === report.agent_id ? 'Reporter' : c.alias,
    is_reporter: c.agent_id === report.agent_id,
    is_me: c.agent_id === me.id,
    body: c.body, created_at: c.created_at,
  };
}

async function socialRoute(req, res, ref, action) {
  const me = requireAgent(req);
  const report = reportWithZone('r.ref = ?', ref);
  if (!report) throw httpError(404, 'Unknown report.');

  if (action === 'comments' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM report_comments WHERE report_id = ? ORDER BY id').all(report.id);
    return json(res, 200, {
      my_alias: report.agent_id === me.id ? 'Reporter' : threadAlias(report.id, me.id),
      comments: rows.map((c) => commentView(c, report, me)),
    });
  }

  if (action === 'comments' && req.method === 'POST') {
    rateLimit(`comment:${me.id}`, 8, 60 * 1000, 'You are commenting very fast.');
    const text = String((await readBody(req)).body || '').trim();
    if (!text) throw httpError(400, 'Write something first.');
    if (text.length > 500) throw httpError(400, 'Keep comments under 500 characters.');
    // Same scrubber as reports: agents must not dox each other (or themselves).
    const { clean, findings } = scrubText(text);
    const c = db.prepare(`INSERT INTO report_comments (report_id, agent_id, alias, body)
                          VALUES (?, ?, ?, ?) RETURNING *`).get(report.id, me.id, threadAlias(report.id, me.id), clean);
    syncComment(c, report);
    syncReport(report.id);
    broadcast('comment', { ref, comments: commentCount(report.id) });
    return json(res, 201, { comment: commentView(c, report, me), findings, comments: commentCount(report.id) });
  }

  if (action === 'react' && req.method === 'POST') {
    const kind = (await readBody(req)).kind;
    if (!REACTIONS.includes(kind)) throw httpError(400, 'Unknown reaction.');
    const had = db.prepare('SELECT 1 FROM report_reactions WHERE report_id = ? AND agent_id = ? AND kind = ?')
      .get(report.id, me.id, kind);
    if (had) db.prepare('DELETE FROM report_reactions WHERE report_id = ? AND agent_id = ? AND kind = ?').run(report.id, me.id, kind);
    else db.prepare('INSERT INTO report_reactions (report_id, agent_id, kind) VALUES (?, ?, ?)').run(report.id, me.id, kind);
    const reactions = reactionCounts(report.id);
    syncReport(report.id);
    broadcast('reaction', { ref, reactions });
    return json(res, 200, { reactions, mine: !had });
  }

  throw httpError(405, 'Method not allowed.');
}

// ── Supabase backup rows (safe fields only — see src/supabase.mjs) ─────────

function syncReport(reportId) {
  if (!CLOUD_ENABLED) return;
  const r = reportWithZone('r.id = ?', reportId);
  queueRow('gp_reports', {
    ref: r.ref, category: r.category, severity: r.severity, status: r.status,
    zone: r.zone, crew: r.crew, landmark: r.landmark,
    lat_blurred: r.lat_fuzzed, lng_blurred: r.lng_fuzzed, precision_m: 150,
    observed_window: fuzzTimestamp(sqlToDate(r.created_at)),
    description: isBlocked(r.id) ? null : r.narrative_safe,
    photo_paths: db.prepare('SELECT stored_name FROM report_media WHERE report_id = ? ORDER BY id').all(r.id)
      .map((m) => `reports/${r.ref}/${m.stored_name}`),
    coins_awarded: r.coins_awarded, verified_by: r.verified_by,
    verified_at: r.verified_at ? sqlToDate(r.verified_at).toISOString() : null,
    reactions: reactionCounts(r.id), comment_count: commentCount(r.id),
    updated_at: new Date().toISOString(),
  }, 'ref');
}

function syncAgent(agentId) {
  if (!CLOUD_ENABLED) return;
  const a = db.prepare(`SELECT a.*, z.name AS zone FROM agents a LEFT JOIN zones z ON z.id = a.home_zone_id
                         WHERE a.id = ?`).get(agentId);
  queueRow('gp_agents', {
    ghost_id: a.ghost_id, avatar: a.avatar, rank: a.rank, xp: a.xp, coins: a.coin_balance,
    home_zone: a.zone, joined_at: sqlToDate(a.created_at).toISOString(), updated_at: new Date().toISOString(),
  }, 'ghost_id');
}

function syncComment(c, report) {
  if (!CLOUD_ENABLED) return;
  queueRow('gp_comments', {
    id: c.id, report_ref: report.ref, alias: c.alias, is_reporter: c.agent_id === report.agent_id,
    body: c.body, created_at: sqlToDate(c.created_at).toISOString(),
  }, 'id');
}

function syncPhotos(reportId) {
  if (!CLOUD_ENABLED) return;
  const { ref } = db.prepare('SELECT ref FROM reports WHERE id = ?').get(reportId);
  for (const m of db.prepare('SELECT stored_name FROM report_media WHERE report_id = ?').all(reportId)) {
    queuePhoto(`reports/${ref}/${m.stored_name}`, m.stored_name);
  }
}

/** First run with Supabase configured: queue everything that already exists. */
function backfillCloud() {
  if (!CLOUD_ENABLED || db.prepare('SELECT COUNT(*) AS n FROM cloud_outbox').get().n) return;
  for (const { id } of db.prepare('SELECT id FROM agents').all()) syncAgent(id);
  for (const { id } of db.prepare('SELECT id FROM reports ORDER BY id').all()) { syncReport(id); syncPhotos(id); }
  for (const c of db.prepare('SELECT * FROM report_comments ORDER BY id').all()) {
    syncComment(c, db.prepare('SELECT ref, agent_id FROM reports WHERE id = ?').get(c.report_id));
  }
}

/** Simulates a City Power / SAPS controller confirming the intel was real. */
function verifyReport(ref, authority = 'City Power Control', outcome = 'verified') {
  const report = db.prepare('SELECT * FROM reports WHERE ref = ?').get(ref);
  if (!report) { const e = new Error('unknown case ref'); e.status = 404; throw e; }
  if (report.status === 'verified') { const e = new Error('already verified'); e.status = 409; throw e; }

  if (outcome !== 'verified') {
    db.prepare(`UPDATE reports SET status = 'rejected', verified_by = ?,
                verified_at = datetime('now') WHERE id = ?`).run(authority, report.id);
    broadcast('verified', { ref, outcome: 'rejected' });
    broadcastStats();
    syncReport(report.id);
    return { ok: true, outcome: 'rejected', ref };
  }

  const mediaCount = db.prepare('SELECT COUNT(*) AS n FROM report_media WHERE report_id = ?')
    .get(report.id).n;
  const { coins, xp } = quoteReward(report.category, report.severity, mediaCount);

  const balance = creditAgent(report.agent_id, coins, `verified:${ref}`, report.id);
  const progression = awardXp(report.agent_id, xp);

  db.prepare(`UPDATE reports SET status = 'verified', verified_by = ?, coins_awarded = ?,
              verified_at = datetime('now') WHERE id = ?`).run(authority, coins, report.id);
  db.prepare('UPDATE zones SET grid_health = MIN(100, grid_health + 6) WHERE id = ?')
    .run(report.zone_id);

  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(report.zone_id);
  // No agent identifier in the broadcast: linking case refs to ghost handles
  // publicly would let anyone map one player's reports. Each client checks its
  // own balance via /api/me instead.
  broadcast('verified', { ref, outcome: 'verified', coins, zone: zone.name, crew: zone.crew });
  broadcast('leaderboard', { crews: crewLeaderboard() });
  broadcastStats();
  syncReport(report.id); syncAgent(report.agent_id);

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(report.agent_id);
  return {
    ok: true, outcome: 'verified', ref, coins, xp, balance,
    rank: progression.rank, badge: progression.badge,
    rank_up: progression.progress === 100 || progression.xp_to_next === 0,
    // Unauthenticated endpoint (stands in for the municipal control room), so
    // only the public ghost handle — never the callsign, which is a login name.
    agent: { ghost_id: agent.ghost_id },
    verified_by: authority,
  };
}

function reportDossier(ref) {
  const r = db.prepare('SELECT * FROM reports WHERE ref = ?').get(ref);
  if (!r) return null;
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(r.zone_id);
  const section = r.section_id ? db.prepare('SELECT name FROM sections WHERE id = ?').get(r.section_id) : null;
  return {
    ref: r.ref, status: r.status, category: r.category, severity: r.severity,
    zone: zone.name, section: section?.name ?? null, crew: zone.crew, created_at: r.created_at,
    coins_awarded: r.coins_awarded, verified_by: r.verified_by,
    narrative_safe: r.narrative_safe,
    // Deliberately absent: narrative_raw, exact coordinates, agent identity.
    media: db.prepare('SELECT stored_name, mime, bytes_in, bytes_out, chunks_removed, sha256_safe FROM report_media WHERE report_id = ?').all(r.id),
    sanitization: db.prepare('SELECT stage, rule, field, hits FROM sanitization_log WHERE report_id = ? ORDER BY id').all(r.id),
    outbound: db.prepare('SELECT endpoint, status, payload_json FROM webhook_outbox WHERE report_id = ?').all(r.id)
      .map((w) => ({ endpoint: w.endpoint, status: w.status, payload: JSON.parse(w.payload_json) })),
    chat: db.prepare('SELECT author, body, created_at FROM intel_messages WHERE report_id = ? ORDER BY id').all(r.id),
  };
}

// ── routes ─────────────────────────────────────────────────────────────────

const routes = {
  'GET /api/bootstrap': (req, res) => {
    const agent = sessionAgent(req);
    json(res, 200, {
      stats: siteStats(),
      avatars: AVATARS,
      zones: zoneLeaderboard(),
      sections: db.prepare('SELECT id, zone_id, name FROM sections ORDER BY zone_id, sort, id').all(),
      catalogue: CATALOGUE,
      ranks: RANKS,
      crews: crewLeaderboard(),
      agent: agent ? agentView(agent) : null,
      safety: {
        prompt: 'Real Msotra heroes report from a safe distance — never approach suspects.',
        rules: [
          'Never approach suspects, vehicles or open chambers.',
          'Report from cover, or after you have walked away.',
          'Ghost Agent is ON: authorities receive zero personal identifiers.',
          'In immediate danger call 10111. This app is not an emergency line.',
        ],
      },
      hotline: [
        { name: 'City Power Call Centre', number: '011 375 5555' },
        { name: 'City Power WhatsApp',    number: '082 041 9741' },
        { name: 'SAPS Emergency',         number: '10111' },
        { name: 'Eskom Contact Centre',   number: '086 003 7566' },
      ],
    });
  },

  // ── profiles ──
  'POST /api/register': async (req, res) => {
    const body = await readBody(req);
    const a = registerAgent(req, res, body);
    broadcastStats();
    syncAgent(a.id);
    json(res, 201, { agent: agentView(a) });
  },

  'POST /api/login': async (req, res) => {
    const body = await readBody(req);
    json(res, 200, { agent: agentView(loginAgent(req, res, body)) });
  },

  'POST /api/logout': (req, res) => {
    endSession(req, res);
    json(res, 200, { ok: true });
  },

  'GET /api/me': (req, res) => json(res, 200, { agent: agentView(requireAgent(req)) }),

  'POST /api/profile': async (req, res) => {
    const a = requireAgent(req);
    const body = await readBody(req);
    if (body.avatar !== undefined) {
      if (!AVATARS.includes(body.avatar)) throw httpError(400, 'Pick one of the listed avatars.');
      db.prepare('UPDATE agents SET avatar = ? WHERE id = ?').run(body.avatar, a.id);
    }
    if (body.home_zone_id !== undefined) {
      db.prepare('UPDATE agents SET home_zone_id = ? WHERE id = ?').run(validZoneId(body.home_zone_id), a.id);
    }
    syncAgent(a.id);
    json(res, 200, { agent: agentView(db.prepare('SELECT * FROM agents WHERE id = ?').get(a.id)) });
  },

  'GET /api/stats': (req, res) => json(res, 200, siteStats()),

  'GET /api/cloud/status': (req, res) => json(res, 200, cloudStatus()),

  // Agent Net feed: 20 reports at a time, newest first. Agents only.
  'GET /api/net': (req, res, url) => {
    const me = requireAgent(req);
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare(`SELECT r.*, z.name AS zone, z.crew, z.landmark, s.name AS section
                               FROM reports r JOIN zones z ON z.id = r.zone_id
                               LEFT JOIN sections s ON s.id = r.section_id
                              WHERE r.id < ? ORDER BY r.id DESC LIMIT 20`).all(before);
    json(res, 200, {
      items: rows.map((r) => netItem(r, me)),
      next: rows.length === 20 ? rows[rows.length - 1].id : null,
    });
  },

  'GET /api/net/item': (req, res, url) => {
    const me = requireAgent(req);
    const r = reportWithZone('r.ref = ?', String(url.searchParams.get('ref') || ''));
    if (!r) throw httpError(404, 'Unknown report.');
    json(res, 200, { item: netItem(r, me) });
  },

  'POST /api/reports': async (req, res) => {
    const agent = requireAgent(req);
    const body = await readBody(req);
    json(res, 201, await submitReport(agent, body));
  },

  'POST /api/verify': async (req, res) => {
    const body = await readBody(req);
    json(res, 200, verifyReport(body.ref, body.authority, body.outcome));
  },

  'GET /api/feed': (req, res) => {
    const rows = db.prepare(`
      SELECT r.ref, r.category, r.severity, r.status, r.created_at, r.coins_awarded,
             z.name AS zone, z.crew, s.name AS section,
             (SELECT COUNT(*) FROM report_media m WHERE m.report_id = r.id) AS media
        FROM reports r JOIN zones z ON z.id = r.zone_id
        LEFT JOIN sections s ON s.id = r.section_id
       ORDER BY r.id DESC LIMIT 25`).all();
    json(res, 200, { feed: rows });
  },

  'GET /api/leaderboard': (req, res) => json(res, 200, {
    crews: crewLeaderboard(), zones: zoneLeaderboard(), agents: agentLeaderboard(),
  }),

  'GET /api/hotzones': (req, res, url) => {
    const lat = Number(url.searchParams.get('lat'));
    const lng = Number(url.searchParams.get('lng'));
    const radius = Number(url.searchParams.get('radius')) || 4000;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json(res, 400, { error: 'lat/lng required' });
    json(res, 200, { hot: hotZonesNear(lat, lng, radius) });
  },

  'GET /api/wallet': (req, res) => {
    const a = requireAgent(req);
    json(res, 200, {
      agent: agentView(a),
      ledger: db.prepare('SELECT delta, reason, balance_after, created_at FROM ledger WHERE agent_id = ? ORDER BY id DESC LIMIT 30').all(a.id),
      redemptions: db.prepare('SELECT sku, label, cost, voucher_code, status, created_at FROM redemptions WHERE agent_id = ? ORDER BY id DESC').all(a.id),
      catalogue: CATALOGUE,
    });
  },

  'POST /api/redeem': async (req, res) => {
    const a = requireAgent(req);
    const body = await readBody(req);
    try {
      const voucher = redeem(a.id, body.sku);
      broadcast('redeem', { ghost_id: a.ghost_id, label: voucher.label });
      syncAgent(a.id);
      json(res, 200, {
        ok: true, voucher,
        agent: agentView(db.prepare('SELECT * FROM agents WHERE id = ?').get(a.id)),
      });
    } catch (e) {
      if (e.code === 'INSUFFICIENT_COINS') return json(res, 402, { error: 'Not enough Msotra Coins yet.' });
      throw e;
    }
  },

  'POST /api/escape/start': async (req, res) => {
    const body = await readBody(req);
    const s = db.prepare(`INSERT INTO escape_sessions (team_name, zone_id, seconds_left)
                          VALUES (?, ?, 300) RETURNING *`)
      .get(String(body.team_name || 'Team Msotra').slice(0, 40), body.zone_id ?? null);
    json(res, 201, { session: s, clues: escapeClues() });
  },

  'POST /api/escape/finish': async (req, res) => {
    const body = await readBody(req);
    // Each session can be finished (and pay out) once.
    const { changes } = db.prepare(`UPDATE escape_sessions SET clues_found = ?, solved = ?, seconds_left = ?,
                ended_at = datetime('now') WHERE id = ? AND ended_at IS NULL`)
      .run(body.clues_found | 0, body.solved ? 1 : 0, body.seconds_left | 0, body.id | 0);
    const a = sessionAgent(req);
    if (changes && body.solved && a) {
      creditAgent(a.id, 60, 'blackout_escape_room');
      awardXp(a.id, 40);
      syncAgent(a.id);
    }
    json(res, 200, {
      ok: true,
      board: db.prepare(`SELECT team_name, clues_found, solved, seconds_left, started_at
                         FROM escape_sessions WHERE ended_at IS NOT NULL
                         ORDER BY solved DESC, seconds_left DESC LIMIT 10`).all(),
    });
  },

  'GET /api/ghost/audit': (req, res) => {
    const summary = db.prepare(`
      SELECT stage, rule, SUM(hits) AS hits, COUNT(*) AS events
        FROM sanitization_log GROUP BY stage, rule ORDER BY hits DESC`).all();
    json(res, 200, {
      allowlist: MUNICIPAL_ALLOWLIST,
      totals: db.prepare('SELECT COUNT(*) AS redactions FROM sanitization_log').get(),
      summary,
      recent_outbound: db.prepare(`SELECT w.endpoint, w.status, w.payload_json, r.ref
                                   FROM webhook_outbox w JOIN reports r ON r.id = w.report_id
                                   ORDER BY w.id DESC LIMIT 5`).all()
        .map((w) => ({ endpoint: w.endpoint, ref: w.ref, payload: JSON.parse(w.payload_json) })),
    });
  },

  'POST /api/ghost/preview': async (req, res) => {
    // Live redaction preview used by the Kasi Intel chat as you type.
    const body = await readBody(req);
    const { clean, findings } = scrubText(body.text || '');
    const geo = Number.isFinite(body.lat) && Number.isFinite(body.lng)
      ? fuzzGeo(body.lat, body.lng) : null;
    json(res, 200, { clean, findings, geo, observed_window: fuzzTimestamp() });
  },
};

function escapeClues() {
  return [
    { id: 1, riddle: 'Zone 9 is dark. The mini-sub hums at the corner where the taxis turn — what number wakes City Power?', answer: '0113755555', hint: 'City Power call centre, no spaces.' },
    { id: 2, riddle: 'Blue lights, not amber. Which three digits do you dial when people, not cables, are in danger?', answer: '10111', hint: 'SAPS emergency.' },
    { id: 3, riddle: 'A Guardian never walks up to the chamber. What is the one word our loading screen repeats?', answer: 'distance', hint: 'Report from a safe ___.' },
  ];
}

// Admin dashboard, City Power / SAPS partner portal, public impact page.
Object.assign(routes, staffRoutes({
  json, readBody, verifyReport, clientIp, liveViewers: () => streams.size,
}));

// ── OpenStreetMap tile proxy ───────────────────────────────────────────────
// The browser never talks to OSM directly: if it did, the tile server would
// log the reporter's IP next to the exact streets they zoomed into. Tiles are
// fetched server-side, cached on disk (so areas seen once work offline), and
// limited to the Soweto area so this can't be used as an open proxy.
const TILE_DIR = join(DATA_DIR, 'tiles');
const TILE_BBOX = { n: -26.15, s: -26.34, w: 27.72, e: 28.03 };
const TILE_ZOOM = [11, 18];
const TILE_UA = 'GhostPuppyGameStudio/1.0 (community civic-reporting demo; tile cache)';
const inflight = new Map();

const lng2x = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

async function serveTile(pathname, res) {
  const m = pathname.match(/^\/tiles\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/);
  if (!m) return json(res, 404, { error: 'not found' });
  const [z, x, y] = m.slice(1).map(Number);
  if (z < TILE_ZOOM[0] || z > TILE_ZOOM[1]
    || x < lng2x(TILE_BBOX.w, z) || x > lng2x(TILE_BBOX.e, z)
    || y < lat2y(TILE_BBOX.n, z) || y > lat2y(TILE_BBOX.s, z)) {
    return json(res, 404, { error: 'outside Soweto tile area' });
  }

  const file = join(TILE_DIR, String(z), String(x), `${y}.png`);
  let buf = await readFile(file).catch(() => null);
  if (!buf) {
    const key = `${z}/${x}/${y}`;
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        const r = await fetch(`https://tile.openstreetmap.org/${key}.png`, {
          headers: { 'user-agent': TILE_UA }, signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`tile upstream ${r.status}`);
        tileStats.fetched++; tileStats.last_ok = new Date().toISOString();
        const data = Buffer.from(await r.arrayBuffer());
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, data);
        return data;
      })().finally(() => inflight.delete(key)));
    }
    buf = await inflight.get(key).catch((err) => {
      tileStats.failed++; tileStats.last_error = { at: new Date().toISOString(), message: err.message };
      return null;
    });
    // Offline and never cached: 503 tells the client to fall back to the grid map.
    if (!buf) return json(res, 503, { error: 'tile unavailable offline' });
  }
  tileStats.served++;
  res.writeHead(200, {
    'content-type': 'image/png', 'content-length': buf.length,
    'cache-control': 'public, max-age=604800',
  });
  res.end(buf);
}

// ── request handler ────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    if (routes[key]) return await routes[key](req, res, url);

    const social = url.pathname.match(/^\/api\/reports\/(GG-[0-9A-F]{6})\/(comments|react)$/);
    if (social) return await socialRoute(req, res, social[1], social[2]);

    if (req.method === 'GET' && url.pathname.startsWith('/api/case/')) {
      const dossier = reportDossier(decodeURIComponent(url.pathname.slice('/api/case/'.length)));
      return dossier ? json(res, 200, dossier) : json(res, 404, { error: 'unknown case ref' });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/tiles/')) {
      return await serveTile(url.pathname, res);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      // Evidence photos are for logged-in agents only (they're metadata-free,
      // but still shouldn't be browsable by anyone who guesses a case ref).
      // Portal staff (admin / partner) may also view them to verify a case.
      if (!staffRole(req)) requireAgent(req);
      const name = url.pathname.slice('/media/'.length);
      if (!/^GG-[0-9A-F]{6}-\d\.(jpg|png)$/.test(name)) return json(res, 404, { error: 'not found' });
      const buf = await readFile(join(MEDIA_DIR, name));
      res.writeHead(200, {
        'content-type': MIME[extname(name)], 'cache-control': 'private, max-age=86400',
      });
      return res.end(buf);
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
      const buf = await readFile(join(PUBLIC, safe));
      res.writeHead(200, { 'content-type': MIME[extname(safe)] || 'text/plain; charset=utf-8' });
      return res.end(buf);
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    if (err.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    console.error('[msotra]', err.message);
    json(res, err.status || 500, { error: err.message || 'server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  ⚡ GHOST PUPPY GAME STUDIO — Grid Guardians`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  Ghost Agent: ARMED  |  DB: data/msotra.db`);
  console.log(CLOUD_ENABLED
    ? `  Supabase: ON — backing up anonymised data + cleaned photos\n`
    : `  Supabase: off (add SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to .env to enable)\n`);
  backfillCloud();
  startCloudSync();
});
