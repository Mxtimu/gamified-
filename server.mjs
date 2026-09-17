// ═══════════════════════════════════════════════════════════════════════════
//  MSOTRA GAMEPLAY LAB — "Spaza Defense & Grid Guardians"
//  Zero-dependency Node server: static frontend + civic-reporting API +
//  Ghost Agent sanitisation boundary + Msotra Coin economy.
// ═══════════════════════════════════════════════════════════════════════════
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, MEDIA_DIR, nearestZone, logSanitization } from './src/db.mjs';
import {
  ghostId, caseRef, scrubText, fuzzGeo, fuzzTimestamp,
  stripImageMetadata, sha256, buildMunicipalPayload, assertNoLeak, assertGeoBlurred,
  MUNICIPAL_ALLOWLIST,
} from './src/ghost.mjs';
import {
  RANKS, rankFor, quoteReward, creditAgent, awardXp, CATALOGUE, redeem,
  crewLeaderboard, zoneLeaderboard, agentLeaderboard, hotZonesNear,
} from './src/economy.mjs';

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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

function upsertAgent(callsign, homeZoneId) {
  const clean = String(callsign || '').trim().slice(0, 24) || 'Anon';
  const existing = db.prepare('SELECT * FROM agents WHERE callsign = ?').get(clean);
  if (existing) {
    if (homeZoneId && homeZoneId !== existing.home_zone_id) {
      db.prepare('UPDATE agents SET home_zone_id = ? WHERE id = ?').run(homeZoneId, existing.id);
      existing.home_zone_id = homeZoneId;
    }
    return existing;
  }
  // ghost_id is derived from a random nonce, NOT from the callsign, so the
  // pseudonym can never be brute-forced back to a chosen name.
  const gid = ghostId(clean + ':' + Date.now() + ':' + Math.random());
  return db.prepare(
    `INSERT INTO agents (callsign, ghost_id, home_zone_id) VALUES (?, ?, ?) RETURNING *`
  ).get(clean, gid, homeZoneId ?? null);
}

function agentView(a) {
  const r = rankFor(a.xp);
  const stats = db.prepare(
    `SELECT COUNT(*) AS reports,
            SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified
       FROM reports WHERE agent_id = ?`
  ).get(a.id);
  return {
    callsign: a.callsign, ghost_id: a.ghost_id, coins: a.coin_balance,
    xp: a.xp, ghost_mode: !!a.ghost_mode, home_zone_id: a.home_zone_id,
    reports: stats.reports || 0, verified: stats.verified || 0, ...r,
  };
}

// ── the reporting pipeline ─────────────────────────────────────────────────

async function submitReport(body) {
  const {
    callsign, category, severity, narrative, lat, lng,
    media = [], chat = [], home_zone_id,
  } = body;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const e = new Error('A map pin is required — drop a coordinate first.');
    e.status = 400; throw e;
  }
  const agent = upsertAgent(callsign, home_zone_id);
  const { zone, distance_m } = nearestZone(lat, lng);

  // Stage 2 — scrub the free-typed narrative + chat transcript.
  const combined = [narrative, ...chat.map((m) => m.body)].filter(Boolean).join(' • ');
  const { clean: narrativeSafe, findings } = scrubText(combined);

  // Stage 3 — blur the pin.
  const geo = fuzzGeo(lat, lng);

  const report = db.prepare(`
    INSERT INTO reports
      (ref, agent_id, zone_id, category, severity, narrative_raw, narrative_safe,
       lat_exact, lng_exact, lat_fuzzed, lng_fuzzed, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')
    RETURNING *`
  ).get(
    caseRef(), agent.id, zone.id, category, Math.min(5, Math.max(1, Number(severity) || 3)),
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
  for (const dataUrl of media.slice(0, 4)) {
    const b64 = String(dataUrl).split(',')[1] || '';
    const raw = Buffer.from(b64, 'base64');
    if (!raw.length) continue;
    const { buffer, removed, mime } = stripImageMetadata(raw);
    if (!buffer) {
      logSanitization(report.id, 'media', 'rejected_unknown_container', 'photo', 1);
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
  const payload = buildMunicipalPayload(report, zone, mediaHashes);
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

  broadcast('report', { ref: report.ref, zone: zone.name, crew: zone.crew,
    category: report.category, severity: report.severity, status: report.status });
  broadcast('leaderboard', { crews: crewLeaderboard() });

  return {
    ok: true,
    report: {
      ref: report.ref, status: report.status, zone: zone.name, crew: zone.crew,
      landmark: zone.landmark, pin_distance_m: distance_m,
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
    agent: agentView(db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id)),
  };
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
  broadcast('verified', { ref, outcome: 'verified', coins, zone: zone.name, crew: zone.crew });
  broadcast('leaderboard', { crews: crewLeaderboard() });

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(report.agent_id);
  return {
    ok: true, outcome: 'verified', ref, coins, xp, balance,
    rank: progression.rank, badge: progression.badge,
    rank_up: progression.progress === 100 || progression.xp_to_next === 0,
    agent: agentView(agent),
    verified_by: authority,
  };
}

function reportDossier(ref) {
  const r = db.prepare('SELECT * FROM reports WHERE ref = ?').get(ref);
  if (!r) return null;
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(r.zone_id);
  return {
    ref: r.ref, status: r.status, category: r.category, severity: r.severity,
    zone: zone.name, crew: zone.crew, created_at: r.created_at,
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
  'GET /api/bootstrap': (req, res, url) => {
    const callsign = url.searchParams.get('callsign');
    const agent = callsign
      ? db.prepare('SELECT * FROM agents WHERE callsign = ?').get(callsign.trim())
      : null;
    json(res, 200, {
      zones: zoneLeaderboard(),
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

  'POST /api/agent': async (req, res) => {
    const body = await readBody(req);
    const a = upsertAgent(body.callsign, body.home_zone_id);
    json(res, 200, { agent: agentView(a) });
  },

  'POST /api/agent/ghost-mode': async (req, res) => {
    const body = await readBody(req);
    const a = upsertAgent(body.callsign);
    db.prepare('UPDATE agents SET ghost_mode = ? WHERE id = ?').run(body.on ? 1 : 0, a.id);
    json(res, 200, { agent: agentView(db.prepare('SELECT * FROM agents WHERE id = ?').get(a.id)) });
  },

  'POST /api/reports': async (req, res) => {
    const body = await readBody(req);
    json(res, 201, await submitReport(body));
  },

  'POST /api/verify': async (req, res) => {
    const body = await readBody(req);
    json(res, 200, verifyReport(body.ref, body.authority, body.outcome));
  },

  'GET /api/feed': (req, res) => {
    const rows = db.prepare(`
      SELECT r.ref, r.category, r.severity, r.status, r.created_at, r.coins_awarded,
             z.name AS zone, z.crew,
             (SELECT COUNT(*) FROM report_media m WHERE m.report_id = r.id) AS media
        FROM reports r JOIN zones z ON z.id = r.zone_id
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

  'GET /api/wallet': (req, res, url) => {
    const callsign = url.searchParams.get('callsign');
    const a = db.prepare('SELECT * FROM agents WHERE callsign = ?').get(String(callsign || '').trim());
    if (!a) return json(res, 404, { error: 'no such agent' });
    json(res, 200, {
      agent: agentView(a),
      ledger: db.prepare('SELECT delta, reason, balance_after, created_at FROM ledger WHERE agent_id = ? ORDER BY id DESC LIMIT 30').all(a.id),
      redemptions: db.prepare('SELECT sku, label, cost, voucher_code, status, created_at FROM redemptions WHERE agent_id = ? ORDER BY id DESC').all(a.id),
      catalogue: CATALOGUE,
    });
  },

  'POST /api/redeem': async (req, res) => {
    const body = await readBody(req);
    const a = db.prepare('SELECT * FROM agents WHERE callsign = ?').get(String(body.callsign || '').trim());
    if (!a) return json(res, 404, { error: 'no such agent' });
    try {
      const voucher = redeem(a.id, body.sku);
      broadcast('redeem', { ghost_id: a.ghost_id, label: voucher.label });
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
    db.prepare(`UPDATE escape_sessions SET clues_found = ?, solved = ?, seconds_left = ?,
                ended_at = datetime('now') WHERE id = ?`)
      .run(body.clues_found | 0, body.solved ? 1 : 0, body.seconds_left | 0, body.id | 0);
    if (body.solved && body.callsign) {
      const a = upsertAgent(body.callsign);
      creditAgent(a.id, 60, 'blackout_escape_room');
      awardXp(a.id, 40);
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

    if (req.method === 'GET' && url.pathname.startsWith('/api/case/')) {
      const dossier = reportDossier(decodeURIComponent(url.pathname.slice('/api/case/'.length)));
      return dossier ? json(res, 200, dossier) : json(res, 404, { error: 'unknown case ref' });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const name = normalize(url.pathname.slice('/media/'.length)).replace(/^(\.\.[/\\])+/, '');
      const buf = await readFile(join(MEDIA_DIR, name));
      res.writeHead(200, { 'content-type': MIME[extname(name)] || 'application/octet-stream' });
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
  console.log(`\n  ⚡ MSOTRA GAMEPLAY LAB — Grid Guardians`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  Ghost Agent: ARMED  |  DB: data/msotra.db\n`);
});
