// ═══════════════════════════════════════════════════════════════════════════
//  GHOST AGENT — data sanitisation pipeline
//
//  Contract: nothing that could identify, locate or expose a Msotra Agent may
//  cross the municipal boundary. Everything forwarded to City Power / SAPS /
//  JMPD passes through here, and every removal is logged as evidence.
//
//  Five stages:
//    1. pseudonymise  — agent identity becomes an unlinkable HMAC handle
//    2. scrubText     — strip PII from free-typed kasi narrative
//    3. fuzzGeo       — snap the pin to a ~150 m grid (zone-accurate, not door-accurate)
//    4. stripImageMetadata — destroy EXIF / GPS / XMP / vendor blocks byte-by-byte
//    5. buildMunicipalPayload + tripwire — strict allowlist, then a final leak scan
// ═══════════════════════════════════════════════════════════════════════════
import { createHmac, createHash, randomBytes } from 'node:crypto';

/**
 * Pseudonymisation key. In production this lives in a KMS and rotates; if it is
 * ever destroyed, the link between ghost_id and agent becomes unrecoverable by
 * design (that is the point — we cannot be compelled to reveal what we cannot
 * compute).
 */
const GHOST_SECRET = process.env.GHOST_SECRET || 'msotra-lab-dev-key-do-not-ship';

// ── Stage 1: identity ──────────────────────────────────────────────────────

export function ghostId(seed) {
  const mac = createHmac('sha256', GHOST_SECRET).update(String(seed)).digest('hex');
  return 'GHOST-' + mac.slice(0, 6).toUpperCase();
}

export function caseRef() {
  return 'GG-' + randomBytes(3).toString('hex').toUpperCase();
}

// ── Stage 2: text ──────────────────────────────────────────────────────────

/**
 * PII rules tuned for South African identifiers plus the self-identification
 * habits people fall into when typing a tip-off ("its me Thabo from no 4432").
 * Order matters: longer/structured patterns run before looser numeric ones.
 */
const TEXT_RULES = [
  { rule: 'sa_id_number',   re: /\b\d{6}[\s-]?\d{4}[\s-]?\d{2}[\s-]?\d\b/g,              sub: '[ID-REDACTED]' },
  { rule: 'sa_mobile',      re: /(\+?27|\b0)[\s-]?[6-8]\d[\s-]?\d{3}[\s-]?\d{4}\b/g,     sub: '[PHONE-REDACTED]' },
  { rule: 'email',          re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/gi,                      sub: '[EMAIL-REDACTED]' },
  { rule: 'url_or_social',  re: /\b(?:https?:\/\/|www\.)\S+/gi,                          sub: '[LINK-REDACTED]' },
  { rule: 'social_handle',  re: /(?:^|\s)@[A-Za-z0-9_]{3,}/g,                            sub: ' [HANDLE-REDACTED]' },
  { rule: 'bank_account',   re: /\b(?:acc(?:ount)?|bank)\s*(?:no|number|#)?\s*:?\s*\d{6,12}\b/gi, sub: '[BANK-REDACTED]' },
  { rule: 'vehicle_plate',  re: /\b[A-Z]{2}\s?\d{2}\s?[A-Z]{2}\s?GP\b/gi,                sub: '[PLATE-REDACTED]' },
  { rule: 'street_address', re: /\b(?:no\.?|number|house|stand|erf|unit)\s*#?\s*\d{1,5}[A-Za-z]?\b/gi, sub: '[ADDRESS-REDACTED]' },
  { rule: 'self_identify',  re: /\b(?:my name is|i am|im|its me|this is|ngu|igama lami (?:ngu|elingu)?)\s+[A-Z][a-z]{2,}\b/gi, sub: '[SELF-ID-REDACTED]' },
  { rule: 'kin_reference',  re: /\b(?:my|u)\s?(?:mother|father|sister|brother|wife|husband|mama|baba|sisi|bhuti|neighbour|landlord)\b/gi, sub: '[RELATION-REDACTED]' },
];

/** Returns { clean, findings: [{rule, hits}] } — never mutates the original. */
export function scrubText(input) {
  let clean = String(input ?? '');
  const findings = [];
  for (const { rule, re, sub } of TEXT_RULES) {
    const matches = clean.match(re);
    if (matches && matches.length) {
      findings.push({ rule, hits: matches.length });
      clean = clean.replace(re, sub);
    }
  }
  // Collapse whitespace so redactions do not leak length information.
  clean = clean.replace(/\s{2,}/g, ' ').trim();
  return { clean, findings };
}

// ── Stage 3: geography ─────────────────────────────────────────────────────

/**
 * Exact coordinates identify a doorstep. We snap to a ~150 m grid so the
 * response crew still gets the right street corner while the reporter's
 * vantage point stays ambiguous. Snapping (not random jitter) means repeat
 * reports from one spot do not average out to the true location.
 */
export const GEO_GRID_DEG = 0.00135; // ≈ 150 m at Soweto's latitude

export function fuzzGeo(lat, lng) {
  const snap = (v) => Math.round(v / GEO_GRID_DEG) * GEO_GRID_DEG;
  const lat_fuzzed = Number(snap(lat).toFixed(5));
  const lng_fuzzed = Number(snap(lng).toFixed(5));
  return {
    lat_fuzzed,
    lng_fuzzed,
    precision_m: 150,
    displaced_m: Math.round(
      Math.hypot((lat_fuzzed - lat) * 111320, (lng_fuzzed - lng) * 100000)
    ),
  };
}

/** Timestamps are rounded to a 15-minute bucket: "when" without "who was out". */
export function fuzzTimestamp(date = new Date()) {
  const ms = 15 * 60 * 1000;
  return new Date(Math.floor(date.getTime() / ms) * ms).toISOString();
}

// ── Stage 4: media ─────────────────────────────────────────────────────────

const JPEG_STRIP_MARKERS = new Set([
  0xe1, // APP1  — EXIF (incl. GPS IFD) and XMP
  0xe2, // APP2  — Flashpix / ICC extras
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, // APP3-7 — vendor (Samsung/Huawei often stash here)
  0xe8, 0xe9, 0xea, 0xeb, 0xec,
  0xed, // APP13 — Photoshop IRB / IPTC (author, city, credit)
  0xee, 0xef,
  0xfe, // COM   — free-text comment
]);

const PNG_STRIP_CHUNKS = new Set([
  'tEXt', 'zTXt', 'iTXt', // arbitrary text, often camera app + account name
  'eXIf',                 // full EXIF block incl. GPS
  'tIME',                 // exact capture minute
  'pHYs', 'iCCP',
]);

/**
 * Rebuilds the image from scratch, copying only the segments needed to render
 * it. Anything that could carry metadata is never written to the new buffer —
 * this is destruction, not flag-clearing.
 * @returns {{ buffer: Buffer, removed: string[], mime: string }}
 */
export function stripImageMetadata(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    return stripJpeg(buf);
  }
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return stripPng(buf);
  }
  // Unknown container: we refuse to guess. Nothing gets forwarded.
  return { buffer: null, removed: ['REJECTED_UNKNOWN_CONTAINER'], mime: 'application/octet-stream' };
}

function stripJpeg(buf) {
  const out = [Buffer.from([0xff, 0xd8])];
  const removed = [];
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) { // start of scan — image data runs to the end
      out.push(buf.subarray(i));
      i = buf.length;
      break;
    }
    if (marker === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); i += 2; break; }
    const len = buf.readUInt16BE(i + 2);
    const segment = buf.subarray(i, i + 2 + len);
    if (JPEG_STRIP_MARKERS.has(marker)) {
      const tag = marker === 0xfe ? 'JPEG:COM'
        : marker === 0xe1 ? 'JPEG:APP1(EXIF/GPS/XMP)'
        : marker === 0xed ? 'JPEG:APP13(IPTC)'
        : `JPEG:APP${marker - 0xe0}`;
      removed.push(tag);
    } else {
      out.push(segment);
    }
    i += 2 + len;
  }
  return { buffer: Buffer.concat(out), removed, mime: 'image/jpeg' };
}

function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  const removed = [];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const total = 12 + len;
    if (PNG_STRIP_CHUNKS.has(type)) {
      removed.push(`PNG:${type}`);
    } else {
      out.push(buf.subarray(i, i + total));
    }
    i += total;
    if (type === 'IEND') break;
  }
  return { buffer: Buffer.concat(out), removed, mime: 'image/png' };
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ── Stage 5: payload allowlist + tripwire ──────────────────────────────────

/**
 * Municipal payload is built by *construction*, not by deletion: we start from
 * an empty object and add only these keys. A new column on `reports` can never
 * accidentally start flowing outward.
 */
export const MUNICIPAL_ALLOWLIST = Object.freeze([
  'case_ref', 'category', 'severity', 'description',
  'zone', 'crew_area', 'landmark', 'lat', 'lng', 'location_precision_m',
  'observed_window', 'evidence_count', 'evidence_hash', 'source',
]);

export function buildMunicipalPayload(report, zone, mediaHashes = []) {
  const safe = {
    case_ref: report.ref,
    category: report.category,
    severity: report.severity,
    description: report.narrative_safe,
    zone: zone.name,
    crew_area: zone.crew,
    landmark: zone.landmark,
    lat: report.lat_fuzzed,
    lng: report.lng_fuzzed,
    location_precision_m: 150,
    observed_window: fuzzTimestamp(new Date(String(report.created_at).replace(' ', 'T') + 'Z')),
    evidence_count: mediaHashes.length,
    evidence_hash: mediaHashes[0] ? mediaHashes[0].slice(0, 16) : null,
    source: 'Grid Guardians / anonymous community report',
  };
  // Enforce the allowlist even against ourselves.
  for (const k of Object.keys(safe)) {
    if (!MUNICIPAL_ALLOWLIST.includes(k)) delete safe[k];
  }
  return safe;
}

/**
 * Machine-generated fields. Their contents are ours, not the reporter's, so
 * running PII patterns over them only produces false positives (a hex evidence
 * hash can contain thirteen consecutive digits and look like an ID number).
 */
const MACHINE_FIELDS = new Set([
  'case_ref', 'evidence_hash', 'observed_window', 'source',
  'zone', 'crew_area', 'landmark', 'category',
]);

/**
 * Final tripwire. Scans the human-authored strings in the outbound payload for
 * any known identifier belonging to this agent, plus a structural re-sweep for
 * PII that survived stage 2. A hit aborts the send — we fail closed, because a
 * leaked payload cannot be recalled.
 *
 * `forbidden` takes STRING identifiers only (callsign, ghost handle). Numbers
 * must never be passed here: substring-matching a float flags its own blurred
 * value ("27.927" is a prefix of "27.92745") and would block honest reports.
 * Coordinates are checked numerically by assertGeoBlurred instead.
 */
export function assertNoLeak(payload, forbidden = []) {
  const violations = [];
  const strings = Object.entries(payload).filter(([, v]) => typeof v === 'string');
  const blob = strings.map(([, v]) => v).join(' | ').toLowerCase();

  for (const secret of forbidden) {
    if (!secret) continue;
    const needle = String(secret).toLowerCase();
    if (/^[-+\d.\s]+$/.test(needle)) continue; // numeric — wrong tool, see above
    if (needle.length >= 3 && blob.includes(needle)) violations.push(needle);
  }

  for (const [key, value] of strings) {
    if (MACHINE_FIELDS.has(key)) continue;
    for (const f of scrubText(value).findings) violations.push(`${key}:${f.rule}`);
  }

  if (violations.length) {
    const err = new Error('GHOST_AGENT_TRIPWIRE: outbound payload blocked');
    err.violations = violations;
    throw err;
  }
  return true;
}

/**
 * The blurred coordinate must never equal the pin the agent actually dropped.
 * Checked as numbers, so no float-formatting surprises.
 */
export function assertGeoBlurred(payload, exactLat, exactLng) {
  if (payload.lat === exactLat || payload.lng === exactLng) {
    const err = new Error('GHOST_AGENT_TRIPWIRE: exact coordinates in payload');
    err.violations = ['exact_coordinates'];
    throw err;
  }
  return true;
}
