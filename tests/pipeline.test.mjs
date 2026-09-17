// Ghost Agent unit tests — the anonymity guarantees, checked directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrubText, fuzzGeo, stripImageMetadata, buildMunicipalPayload,
  assertNoLeak, ghostId, MUNICIPAL_ALLOWLIST,
} from '../src/ghost.mjs';

test('scrubText removes SA phone numbers, ID numbers, emails and self-identification', () => {
  const input = 'Hi its me Thabo from no 4432 Vilakazi, call 082 555 1234 or thabo@gmail.com, ID 8801015800085';
  const { clean, findings } = scrubText(input);
  const rules = findings.map((f) => f.rule);

  assert.ok(rules.includes('sa_mobile'), 'phone rule fired');
  assert.ok(rules.includes('email'), 'email rule fired');
  assert.ok(rules.includes('sa_id_number'), 'ID rule fired');
  assert.ok(rules.includes('self_identify'), 'self-identification rule fired');

  assert.ok(!/0825551234|082 555 1234/.test(clean), 'phone gone');
  assert.ok(!clean.includes('thabo@gmail.com'), 'email gone');
  assert.ok(!clean.includes('8801015800085'), 'ID gone');
  assert.ok(!/Thabo/i.test(clean), 'name gone');
});

test('scrubText leaves genuinely useful operational detail intact', () => {
  const { clean } = scrubText('Three guys cutting the main cable behind the transformer box near the taxi rank');
  assert.ok(clean.includes('cutting the main cable'));
  assert.ok(clean.includes('taxi rank'));
});

test('fuzzGeo snaps deterministically to a ~150m grid', () => {
  const a = fuzzGeo(-26.238512, 27.905611);
  const b = fuzzGeo(-26.238512, 27.905611);
  assert.deepEqual(a, b, 'snapping is deterministic — averaging attacks gain nothing');
  assert.notEqual(a.lat_fuzzed, -26.238512, 'exact latitude never forwarded');
  assert.equal(a.precision_m, 150);
  assert.ok(a.displaced_m <= 160, `displacement stays zone-useful (${a.displaced_m} m)`);
});

test('stripImageMetadata destroys EXIF/GPS, IPTC and comment segments in a JPEG', () => {
  const seg = (marker, payload) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
  };
  const exif = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from('MM\0*'), // TIFF header
    Buffer.from('GPSLatitude -26.2385 GPSLongitude 27.9056 OwnerName Thabo', 'latin1'),
  ]);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, exif),                                        // APP1  EXIF + GPS
    seg(0xed, Buffer.from('Photoshop 3.0 author:Thabo')),   // APP13 IPTC
    seg(0xfe, Buffer.from('taken on my phone at home')),     // COM
    seg(0xdb, Buffer.alloc(64, 1)),                          // DQT — must survive
    Buffer.from([0xff, 0xda]), Buffer.from([0x00, 0x08, 1, 1, 1, 1, 1, 1]),
    Buffer.from([0xff, 0xd9]),
  ]);

  const { buffer, removed, mime } = stripImageMetadata(jpeg);
  assert.equal(mime, 'image/jpeg');
  assert.ok(removed.includes('JPEG:APP1(EXIF/GPS/XMP)'));
  assert.ok(removed.includes('JPEG:APP13(IPTC)'));
  assert.ok(removed.includes('JPEG:COM'));

  const out = buffer.toString('latin1');
  assert.ok(!out.includes('GPSLatitude'), 'GPS bytes destroyed');
  assert.ok(!out.includes('Thabo'), 'owner name destroyed');
  assert.ok(!out.includes('taken on my phone'), 'comment destroyed');
  assert.ok(buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'still a JPEG');
  assert.ok(buffer.includes(Buffer.alloc(64, 1)), 'image tables preserved');
  assert.ok(buffer.length < jpeg.length, 'file got smaller');
});

test('stripImageMetadata destroys PNG text and eXIf chunks', () => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.alloc(13, 2)),
    chunk('tEXt', Buffer.from('Author\0Thabo Mokoena')),
    chunk('eXIf', Buffer.from('GPS -26.2385 27.9056')),
    chunk('IDAT', Buffer.alloc(20, 7)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const { buffer, removed } = stripImageMetadata(png);
  assert.ok(removed.includes('PNG:tEXt') && removed.includes('PNG:eXIf'));
  const out = buffer.toString('latin1');
  assert.ok(!out.includes('Thabo Mokoena'));
  assert.ok(!out.includes('GPS -26.2385'));
  assert.ok(buffer.includes(Buffer.alloc(20, 7)), 'pixel data preserved');
});

test('stripImageMetadata refuses unknown containers rather than guessing', () => {
  const { buffer, removed } = stripImageMetadata(Buffer.from('RIFF....WEBPsomething'));
  assert.equal(buffer, null);
  assert.deepEqual(removed, ['REJECTED_UNKNOWN_CONTAINER']);
});

test('municipal payload is built by allowlist and carries no agent identifiers', () => {
  const report = {
    ref: 'GG-ABC123', category: 'cable_theft', severity: 4,
    narrative_raw: 'its me Thabo on 082 555 1234',
    narrative_safe: 'Three men cutting cable behind the transformer box',
    lat_exact: -26.238512, lng_exact: 27.905611,
    lat_fuzzed: -26.2385, lng_fuzzed: 27.9059,
    created_at: '2026-09-17 21:14:33',
    agent_id: 42, id: 7,
  };
  const zone = { name: 'Orlando West', crew: 'Orlando Crew', landmark: 'Vilakazi Street' };
  const payload = buildMunicipalPayload(report, zone, ['a'.repeat(64)]);

  for (const key of Object.keys(payload)) {
    assert.ok(MUNICIPAL_ALLOWLIST.includes(key), `${key} is allowlisted`);
  }
  assert.equal(payload.agent_id, undefined);
  assert.equal(payload.narrative_raw, undefined);
  assert.equal(payload.lat, -26.2385);
  assert.notEqual(payload.lat, report.lat_exact);
  assert.match(payload.observed_window, /T\d\d:(00|15|30|45):00/, 'timestamp rounded to 15 min');
  assert.equal(payload.source, 'Grid Guardians / anonymous community report');
});

test('tripwire blocks a payload that would leak an identifier', () => {
  const leaky = { case_ref: 'GG-1', description: 'reported by Ma2000 on 082 555 1234' };
  assert.throws(() => assertNoLeak(leaky, ['Ma2000']), /TRIPWIRE/);
});

test('tripwire passes a clean payload', () => {
  const clean = {
    case_ref: 'GG-2', category: 'open_chamber', severity: 3,
    description: 'Open chamber next to the taxi rank, cover missing',
    zone: 'Pimville', lat: -26.276, lng: 27.899,
  };
  assert.equal(assertNoLeak(clean, ['Ma2000', 'GHOST-AB12CD']), true);
});

test('ghost handles are stable per seed and unlinkable across agents', () => {
  assert.equal(ghostId('seed-1'), ghostId('seed-1'));
  assert.notEqual(ghostId('seed-1'), ghostId('seed-2'));
  assert.match(ghostId('seed-1'), /^GHOST-[0-9A-F]{6}$/);
});
