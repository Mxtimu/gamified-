// Staff portals: the admin dashboard (/admin.html), the City Power / SAPS
// partner view (/partner.html) and the public impact page (/impact.html).
//
// The anonymity promise still holds here. No portal shows which agent filed
// which report, exact pins, or raw narratives: admins see agents and reports as
// separate lists, and reports only in their blurred, scrubbed form.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { db, DATA_DIR, MEDIA_DIR } from './db.mjs';
import { staffLogin, staffLogout, staffRole, staffEnabled, requireStaff, rateLimit, httpError } from './auth.mjs';
import { cloudStatus, CLOUD_ENABLED } from './supabase.mjs';

const STARTED_AT = new Date();
const STATUSES = ['submitted', 'forwarded', 'verified', 'rejected'];
const sqlIso = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z').toISOString() : null);
const isBlocked = (reportId) => Boolean(db.prepare(
  `SELECT 1 FROM sanitization_log WHERE report_id = ? AND stage = 'tripwire'`).get(reportId));
const int = (v) => (Number.isInteger(Number(v)) && v !== '' && v != null ? Number(v) : null);

/** Tile proxy health, filled in by server.mjs as tiles are fetched. */
export const tileStats = { served: 0, fetched: 0, failed: 0, last_ok: null, last_error: null };

// Folder sizes are slow to walk; recompute at most once a minute.
const dirCache = new Map();
async function dirUsage(dir) {
  const hit = dirCache.get(dir);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let files = 0, bytes = 0;
  try {
    for (const name of await readdir(dir, { recursive: true })) {
      const s = await stat(join(dir, name)).catch(() => null);
      if (s?.isFile()) { files++; bytes += s.size; }
    }
  } catch { /* folder missing: report zero */ }
  const value = { files, bytes };
  dirCache.set(dir, { at: Date.now(), value });
  return value;
}

/** Blurred, scrubbed report as staff may see it. No agent link, no exact pin. */
function staffReport(r) {
  return {
    ref: r.ref, category: r.category, severity: r.severity, status: r.status,
    township: r.zone, section: r.section, crew: r.crew, landmark: r.landmark,
    lat: r.lat_fuzzed, lng: r.lng_fuzzed, precision_m: 150,
    created_at: sqlIso(r.created_at), verified_at: sqlIso(r.verified_at), verified_by: r.verified_by,
    coins_awarded: r.coins_awarded,
    description: isBlocked(r.id) ? null : r.narrative_safe,
    blocked: isBlocked(r.id),
    photos: db.prepare('SELECT stored_name FROM report_media WHERE report_id = ? ORDER BY id').all(r.id)
      .map((m) => `/media/${m.stored_name}`),
    sent_to: db.prepare('SELECT DISTINCT endpoint FROM webhook_outbox WHERE report_id = ?').all(r.id)
      .map((w) => w.endpoint),
    comments: db.prepare('SELECT COUNT(*) AS n FROM report_comments WHERE report_id = ?').get(r.id).n,
  };
}

const REPORT_SELECT = `SELECT r.*, z.name AS zone, z.crew, z.landmark, s.name AS section
                         FROM reports r JOIN zones z ON z.id = r.zone_id
                         LEFT JOIN sections s ON s.id = r.section_id`;

/** Filtered page of reports, newest first. */
function listReports(url, { openOnly = false } = {}) {
  const where = [], args = [];
  const status = url.searchParams.get('status');
  if (openOnly && (!status || status === 'open')) where.push(`r.status IN ('submitted','forwarded')`);
  else if (STATUSES.includes(status)) { where.push('r.status = ?'); args.push(status); }
  const zone = int(url.searchParams.get('zone_id'));
  if (zone) { where.push('r.zone_id = ?'); args.push(zone); }
  const category = url.searchParams.get('category');
  if (category) { where.push('r.category = ?'); args.push(category); }
  const q = String(url.searchParams.get('q') || '').trim().toUpperCase();
  if (q) { where.push('r.ref LIKE ?'); args.push(`%${q}%`); }
  const before = int(url.searchParams.get('before'));
  if (before) { where.push('r.id < ?'); args.push(before); }
  const rows = db.prepare(`${REPORT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                            ORDER BY r.id DESC LIMIT 50`).all(...args);
  return { items: rows.map(staffReport), next: rows.length === 50 ? rows[rows.length - 1].id : null };
}

export function staffRoutes({ json, readBody, verifyReport, clientIp, liveViewers }) {
  const authorityFor = (role, body) => {
    if (role === 'partner') return body.authority === 'SAPS' ? 'SAPS (partner portal)' : 'City Power (partner portal)';
    return 'Admin portal';
  };
  const decide = async (req, res, role) => {
    const body = await readBody(req);
    const outcome = body.outcome === 'rejected' ? 'rejected' : 'verified';
    const ref = String(body.ref || '');
    if (!/^GG-[0-9A-F]{6}$/.test(ref)) throw httpError(400, 'Unknown case ref.');
    const r = verifyReport(ref, authorityFor(role, body), outcome);
    json(res, 200, { ok: true, outcome: r.outcome, ref, coins: r.coins ?? 0 });
  };

  return {
    // ── sign in / out (both portals) ───────────────────────────────────────
    'GET /api/staff/me': (req, res) => json(res, 200, {
      role: staffRole(req),
      admin_enabled: staffEnabled('admin'), partner_enabled: staffEnabled('partner'),
    }),
    'POST /api/staff/login': async (req, res) => {
      rateLimit(`staff:${clientIp(req)}`, 8, 15 * 60_000, 'Too many attempts.');
      const body = await readBody(req);
      staffLogin(res, body.role, body.password);
      json(res, 200, { ok: true, role: body.role });
    },
    'POST /api/staff/logout': (req, res) => { staffLogout(req, res); json(res, 200, { ok: true }); },

    // ── admin: overview ────────────────────────────────────────────────────
    'GET /api/admin/overview': (req, res) => {
      requireStaff(req, 'admin');
      const totals = db.prepare(`
        SELECT (SELECT COUNT(*) FROM agents WHERE pin_hash IS NOT NULL) AS agents,
               (SELECT COUNT(*) FROM agents WHERE pin_hash IS NOT NULL AND created_at >= datetime('now','-7 days')) AS agents_new_7d,
               (SELECT COUNT(DISTINCT agent_id) FROM reports WHERE created_at >= datetime('now','-7 days')) AS agents_active_7d,
               (SELECT COUNT(*) FROM reports) AS reports,
               (SELECT COUNT(*) FROM reports WHERE created_at >= datetime('now','start of day')) AS reports_today,
               (SELECT COUNT(*) FROM reports WHERE created_at >= datetime('now','-7 days')) AS reports_7d,
               (SELECT COALESCE(SUM(delta),0) FROM ledger WHERE delta > 0) AS coins_issued,
               (SELECT COALESCE(SUM(cost),0) FROM redemptions) AS coins_redeemed,
               (SELECT COALESCE(SUM(coin_balance),0) FROM agents) AS coins_outstanding,
               (SELECT COUNT(*) FROM redemptions) AS redemptions,
               (SELECT COUNT(*) FROM zones) AS townships,
               (SELECT COUNT(DISTINCT zone_id) FROM reports) AS townships_reporting`).get();
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM reports GROUP BY status').all()) byStatus[r.status] = r.n;

      // Last 30 days, one row per day (zero-filled so the chart has no gaps).
      const counts = new Map(db.prepare(`
        SELECT date(created_at) AS d, COUNT(*) AS n,
               SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS v
          FROM reports WHERE created_at >= date('now','-29 days') GROUP BY d`).all().map((r) => [r.d, r]));
      const daily = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
        daily.push({ date: d, reports: counts.get(d)?.n ?? 0, verified: counts.get(d)?.v ?? 0 });
      }

      json(res, 200, {
        totals, by_status: byStatus, daily,
        by_category: db.prepare(`SELECT category, COUNT(*) AS n FROM reports GROUP BY category ORDER BY n DESC`).all(),
        top_townships: db.prepare(`
          SELECT z.name AS township, COUNT(r.id) AS reports,
                 SUM(CASE WHEN r.status = 'verified' THEN 1 ELSE 0 END) AS verified, z.grid_health
            FROM zones z JOIN reports r ON r.zone_id = z.id
           GROUP BY z.id ORDER BY reports DESC LIMIT 10`).all(),
        recent: db.prepare(`
          SELECT * FROM (
            SELECT 'report' AS kind, created_at AS at, ref AS label, category AS detail FROM reports
            UNION ALL SELECT 'verified', verified_at, ref, verified_by FROM reports WHERE status = 'verified'
            UNION ALL SELECT 'rejected', verified_at, ref, verified_by FROM reports WHERE status = 'rejected'
            UNION ALL SELECT 'redemption', created_at, label, cost || ' coins' FROM redemptions
            UNION ALL SELECT 'agent', created_at, ghost_id, 'joined' FROM agents WHERE pin_hash IS NOT NULL
          ) ORDER BY at DESC LIMIT 15`).all().map((e) => ({ ...e, at: sqlIso(e.at) })),
      });
    },

    // ── admin: reports ─────────────────────────────────────────────────────
    'GET /api/admin/reports': (req, res, url) => { requireStaff(req, 'admin'); json(res, 200, listReports(url)); },
    'POST /api/admin/verify': async (req, res) => decide(req, res, requireStaff(req, 'admin')),

    // ── admin: delivery to City Power / SAPS ───────────────────────────────
    'GET /api/admin/delivery': (req, res) => {
      requireStaff(req, 'admin');
      const endpoints = {};
      for (const r of db.prepare(`SELECT endpoint, status, COUNT(*) AS n FROM webhook_outbox GROUP BY endpoint, status`).all()) {
        (endpoints[r.endpoint] ||= {})[r.status] = r.n;
      }
      const timing = db.prepare(`
        SELECT COUNT(*) AS decided,
               ROUND(AVG((julianday(verified_at) - julianday(created_at)) * 24), 1) AS avg_hours,
               ROUND(MAX((julianday(verified_at) - julianday(created_at)) * 24), 1) AS max_hours
          FROM reports WHERE verified_at IS NOT NULL`).get();
      const blocked = db.prepare(`SELECT COUNT(DISTINCT report_id) AS n FROM sanitization_log WHERE stage = 'tripwire'`).get().n;
      const waiting = db.prepare(`${REPORT_SELECT} WHERE r.status IN ('submitted','forwarded')
                                   ORDER BY r.id ASC LIMIT 50`).all()
        .map((r) => ({ ...staffReport(r),
          age_hours: Math.round((Date.now() - new Date(r.created_at.replace(' ', 'T') + 'Z')) / 36e5) }));
      json(res, 200, {
        live: false, // outbox is recorded locally; no live City Power endpoint is wired up yet
        endpoints, timing, blocked_by_tripwire: blocked, waiting,
        by_authority: db.prepare(`SELECT verified_by AS authority, status, COUNT(*) AS n FROM reports
                                   WHERE verified_by IS NOT NULL GROUP BY verified_by, status ORDER BY n DESC`).all(),
      });
    },

    // ── admin: agents (no link to individual reports) ──────────────────────
    'GET /api/admin/agents': (req, res) => {
      requireStaff(req, 'admin');
      json(res, 200, { agents: db.prepare(`
        SELECT a.ghost_id, a.callsign, a.avatar, a.rank, a.xp, a.coin_balance AS coins,
               z.name AS home_township, a.created_at,
               (SELECT COUNT(*) FROM reports r WHERE r.agent_id = a.id) AS reports,
               (SELECT COUNT(*) FROM reports r WHERE r.agent_id = a.id AND r.status = 'verified') AS verified,
               (SELECT MAX(created_at) FROM reports r WHERE r.agent_id = a.id) AS last_report
          FROM agents a LEFT JOIN zones z ON z.id = a.home_zone_id
         WHERE a.pin_hash IS NOT NULL ORDER BY a.id DESC`).all()
        .map((a) => ({ ...a, created_at: sqlIso(a.created_at), last_report: sqlIso(a.last_report) })) });
    },

    // ── admin: wallet / vouchers ───────────────────────────────────────────
    'GET /api/admin/redemptions': (req, res) => {
      requireStaff(req, 'admin');
      json(res, 200, {
        by_item: db.prepare(`SELECT label, COUNT(*) AS n, SUM(cost) AS coins FROM redemptions GROUP BY sku ORDER BY n DESC`).all(),
        recent: db.prepare(`SELECT r.label, r.cost, r.status, r.created_at, r.voucher_code, a.ghost_id
                              FROM redemptions r JOIN agents a ON a.id = r.agent_id ORDER BY r.id DESC LIMIT 100`).all()
          // Voucher codes are spendable; show only the end so a screen-share can't leak them.
          .map((r) => ({ ...r, voucher_code: '••••' + String(r.voucher_code).slice(-4), created_at: sqlIso(r.created_at) })),
      });
    },

    // ── admin: moderation ──────────────────────────────────────────────────
    'GET /api/admin/comments': (req, res) => {
      requireStaff(req, 'admin');
      json(res, 200, { comments: db.prepare(`
        SELECT c.id, c.alias, c.body, c.created_at, r.ref
          FROM report_comments c JOIN reports r ON r.id = c.report_id ORDER BY c.id DESC LIMIT 100`).all()
        .map((c) => ({ ...c, created_at: sqlIso(c.created_at) })) });
    },
    'POST /api/admin/comments/delete': async (req, res) => {
      requireStaff(req, 'admin');
      const id = int((await readBody(req)).id);
      const n = id ? db.prepare('DELETE FROM report_comments WHERE id = ?').run(id).changes : 0;
      if (!n) throw httpError(404, 'Comment not found.');
      json(res, 200, { ok: true });
    },

    // ── admin: system & cloud health ───────────────────────────────────────
    'GET /api/admin/health': async (req, res) => {
      requireStaff(req, 'admin');
      const dbFile = process.env.DB_FILE || join(DATA_DIR, 'msotra.db');
      const dbBytes = (await Promise.all(['', '-wal', '-shm'].map((s) => stat(dbFile + s).catch(() => null))))
        .reduce((n, s) => n + (s?.size || 0), 0);
      const outbox = db.prepare(`
        SELECT SUM(done_at IS NULL) AS pending, SUM(done_at IS NOT NULL) AS done,
               SUM(done_at IS NULL AND attempts > 0) AS retrying FROM cloud_outbox`).get();
      const warnings = [];
      if (!process.env.GHOST_SECRET) warnings.push('GHOST_SECRET is not set: ghost handles use the built-in development key.');
      if (!process.env.PHONE_SECRET) warnings.push('PHONE_SECRET is not set: phone hashes use the built-in development key.');
      warnings.push('POST /api/verify (the Wallet "Control Room Simulator") needs no login: anyone can verify a report and pay out coins.');
      if (!CLOUD_ENABLED) warnings.push('Supabase backup is off: data lives only on this machine.');
      if (!staffEnabled('partner')) warnings.push('Partner portal is off (PARTNER_PASSWORD not set).');
      json(res, 200, {
        server: {
          started_at: STARTED_AT.toISOString(), uptime_s: Math.round(process.uptime()),
          node: process.versions.node, memory_mb: Math.round(process.memoryUsage().rss / 1048576),
          live_viewers: liveViewers(),
        },
        storage: {
          db_bytes: dbBytes,
          media: await dirUsage(MEDIA_DIR),
          tiles: await dirUsage(join(DATA_DIR, 'tiles')),
        },
        cloud: { ...cloudStatus(), outbox: { pending: outbox.pending || 0, done: outbox.done || 0, retrying: outbox.retrying || 0 },
          recent_errors: db.prepare(`SELECT target, attempts, last_error, next_try_at FROM cloud_outbox
                                      WHERE done_at IS NULL AND last_error IS NOT NULL ORDER BY id DESC LIMIT 5`).all() },
        tiles: tileStats,
        warnings,
      });
    },

    // ── partner portal (City Power / SAPS) ─────────────────────────────────
    'GET /api/partner/reports': (req, res, url) => {
      requireStaff(req, 'partner');
      json(res, 200, listReports(url, { openOnly: true }));
    },
    'POST /api/partner/verify': async (req, res) => decide(req, res, requireStaff(req, 'partner')),
    'GET /api/partner/zones': (req, res) => {
      requireStaff(req, 'partner');
      json(res, 200, { zones: db.prepare('SELECT id, name FROM zones ORDER BY name').all() });
    },

    // ── public impact page (no login, totals only) ─────────────────────────
    'GET /api/public/impact': (req, res) => {
      const t = db.prepare(`
        SELECT COUNT(*) AS reports,
               COALESCE(SUM(status = 'verified'), 0) AS verified,
               COALESCE(SUM(coins_awarded), 0) AS coins_paid,
               COUNT(DISTINCT zone_id) AS townships_reporting,
               (SELECT COUNT(*) FROM zones) AS townships,
               (SELECT COUNT(*) FROM agents WHERE pin_hash IS NOT NULL) AS agents
          FROM reports`).get();
      json(res, 200, {
        totals: t,
        by_category: db.prepare(`SELECT category, COUNT(*) AS n FROM reports GROUP BY category ORDER BY n DESC`).all(),
        // Townships with fewer than 3 reports are left out so a single reporter can't be singled out.
        townships: db.prepare(`
          SELECT z.name AS township, COUNT(r.id) AS reports,
                 SUM(CASE WHEN r.status = 'verified' THEN 1 ELSE 0 END) AS verified
            FROM zones z JOIN reports r ON r.zone_id = z.id
           GROUP BY z.id HAVING COUNT(r.id) >= 3 ORDER BY reports DESC LIMIT 15`).all(),
        updated_at: new Date().toISOString(),
      });
    },
  };
}
