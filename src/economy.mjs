// Msotra Coin virtual economy: append-only ledger, tiered ranks, redemption
// gateway and the geospatial leaderboard queries behind the Hood Leaderboard.
import { randomBytes } from 'node:crypto';
import { db } from './db.mjs';

export const RANKS = [
  { name: 'Observer',      xp: 0,   badge: '👁️' },
  { name: 'Street Captain', xp: 150, badge: '🎖️' },
  { name: 'Soweto Legend',  xp: 500, badge: '👑' },
];

export function rankFor(xp) {
  let current = RANKS[0];
  for (const r of RANKS) if (xp >= r.xp) current = r;
  const next = RANKS.find((r) => r.xp > xp) || null;
  return {
    rank: current.name,
    badge: current.badge,
    next: next ? next.name : null,
    xp_to_next: next ? next.xp - xp : 0,
    progress: next ? Math.round(((xp - current.xp) / (next.xp - current.xp)) * 100) : 100,
  };
}

/** Payout table. Higher-risk grid assets pay more; photo evidence pays a bonus. */
const CATEGORY_VALUE = {
  cable_theft:          40,
  substation_vandalism: 35,
  open_chamber:         25,
  illegal_connection:   20,
  streetlight_out:      10,
};

export function quoteReward(category, severity, mediaCount) {
  const base = CATEGORY_VALUE[category] ?? 10;
  const coins = Math.round(base * (1 + (severity - 1) * 0.35)) + (mediaCount > 0 ? 25 : 0);
  return { coins, xp: Math.round(coins * 0.8) };
}

/**
 * Single source of truth for balance changes. Writes the ledger row and the
 * cached balance in one transaction so they can never drift.
 */
export function creditAgent(agentId, delta, reason, reportId = null) {
  const tx = db.prepare('SELECT coin_balance, xp FROM agents WHERE id = ?').get(agentId);
  if (!tx) throw new Error('unknown agent');
  const balanceAfter = tx.coin_balance + delta;
  if (balanceAfter < 0) {
    const err = new Error('INSUFFICIENT_COINS');
    err.code = 'INSUFFICIENT_COINS';
    throw err;
  }
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE agents SET coin_balance = ? WHERE id = ?').run(balanceAfter, agentId);
    db.prepare(
      `INSERT INTO ledger (agent_id, delta, reason, report_id, balance_after)
       VALUES (?, ?, ?, ?, ?)`
    ).run(agentId, delta, reason, reportId, balanceAfter);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return balanceAfter;
}

export function awardXp(agentId, xp) {
  const row = db.prepare('SELECT xp FROM agents WHERE id = ?').get(agentId);
  const total = row.xp + xp;
  const { rank } = rankFor(total);
  db.prepare('UPDATE agents SET xp = ?, rank = ? WHERE id = ?').run(total, rank, agentId);
  return { xp: total, ...rankFor(total) };
}

export const CATALOGUE = [
  { sku: 'airtime_10',  label: 'R10 Airtime (any network)', cost: 120, icon: '📱', kind: 'airtime' },
  { sku: 'data_500mb',  label: '500MB Data Bundle',         cost: 200, icon: '📶', kind: 'data' },
  { sku: 'data_1gb',    label: '1GB Data Bundle',           cost: 350, icon: '📶', kind: 'data' },
  { sku: 'eskom_50',    label: 'R50 Eskom Prepaid Token',   cost: 500, icon: '⚡', kind: 'electricity' },
  { sku: 'eskom_100',   label: 'R100 Eskom Prepaid Token',  cost: 900, icon: '⚡', kind: 'electricity' },
];

function voucherFor(kind) {
  const raw = randomBytes(10).toString('hex').toUpperCase();
  if (kind === 'electricity') {
    // Eskom prepaid tokens are 20 digits in 4-digit groups.
    const digits = BigInt('0x' + raw).toString().padStart(20, '0').slice(0, 20);
    return digits.match(/.{1,4}/g).join(' ');
  }
  return raw.match(/.{1,4}/g).join('-');
}

export function redeem(agentId, sku) {
  const item = CATALOGUE.find((c) => c.sku === sku);
  if (!item) throw new Error('unknown sku');
  creditAgent(agentId, -item.cost, `redeem:${sku}`);
  const code = voucherFor(item.kind);
  const info = db.prepare(
    `INSERT INTO redemptions (agent_id, sku, label, cost, voucher_code)
     VALUES (?, ?, ?, ?, ?) RETURNING *`
  ).get(agentId, sku, item.label, item.cost, code);
  return info;
}

// ── Hood Leaderboard: aggregate per crew area, weighted by verified intel ───

export function crewLeaderboard() {
  return db.prepare(`
    SELECT z.crew AS crew,
           COUNT(r.id)                                              AS reports,
           SUM(CASE WHEN r.status = 'verified' THEN 1 ELSE 0 END)    AS verified,
           COALESCE(SUM(r.coins_awarded), 0)                         AS coins,
           ROUND(AVG(z.grid_health), 1)                              AS grid_health,
           COUNT(DISTINCT r.agent_id)                                AS active_agents,
           COALESCE(SUM(CASE WHEN r.status = 'verified'
                THEN r.severity * 10 ELSE r.severity * 2 END), 0)     AS score
      FROM zones z
      LEFT JOIN reports r ON r.zone_id = z.id
     GROUP BY z.crew
     ORDER BY score DESC, verified DESC, reports DESC
  `).all();
}

export function zoneLeaderboard() {
  return db.prepare(`
    SELECT z.id, z.name, z.crew, z.lat, z.lng, z.landmark, z.grid_health,
           COUNT(r.id)                                           AS reports,
           SUM(CASE WHEN r.status = 'verified' THEN 1 ELSE 0 END) AS verified,
           COALESCE(SUM(r.coins_awarded), 0)                      AS coins
      FROM zones z
      LEFT JOIN reports r ON r.zone_id = z.id
     GROUP BY z.id
     ORDER BY verified DESC, reports DESC, z.name
  `).all();
}

export function agentLeaderboard(limit = 10) {
  return db.prepare(`
    SELECT a.ghost_id, a.callsign, a.rank, a.xp, a.coin_balance,
           z.name AS home_zone,
           COUNT(r.id)                                           AS reports,
           SUM(CASE WHEN r.status = 'verified' THEN 1 ELSE 0 END) AS verified
      FROM agents a
      LEFT JOIN reports r ON r.agent_id = a.id
      LEFT JOIN zones  z ON z.id = a.home_zone_id
     GROUP BY a.id
     ORDER BY a.xp DESC, verified DESC
     LIMIT ?
  `).all(limit);
}

/** Hot zones inside a radius — the geospatial query for the tactical map. */
export function hotZonesNear(lat, lng, radiusM = 4000) {
  const rows = zoneLeaderboard();
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  return rows
    .map((z) => {
      const dLat = toRad(z.lat - lat), dLng = toRad(z.lng - lng);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat)) * Math.cos(toRad(z.lat)) * Math.sin(dLng / 2) ** 2;
      return { ...z, distance_m: Math.round(2 * R * Math.asin(Math.sqrt(a))) };
    })
    .filter((z) => z.distance_m <= radiusM)
    .sort((a, b) => a.distance_m - b.distance_m);
}
