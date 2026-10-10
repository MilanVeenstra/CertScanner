// Fixture integrity (no browser): files match their manifests, the benchmark meets its size/count budget,
// and the orchestrator decisions on expectations are encoded. Regenerate with `npm run fixtures`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BENCH, FIXTURES } from './lib/env.mjs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const main = JSON.parse(readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
const bench = JSON.parse(readFileSync(path.join(BENCH, 'bench-manifest.json'), 'utf8'));
const VALID_LEN = { psa: [7, 8, 9, 10], 'cgc-comics': [10], 'cgc-cards': [10, 13] };

test('main fixtures match manifest.json (sha256, bytes)', () => {
  for (const f of main.fixtures) {
    const p = path.join(FIXTURES, f.file);
    assert.equal(statSync(p).size, f.bytes, f.file);
    assert.equal(sha(p), f.sha256, f.file);
  }
  for (const f of main.securityFixtures ?? []) {
    assert.equal(statSync(path.join(FIXTURES, f.file)).size, f.bytes, f.file);
    assert.equal(sha(path.join(FIXTURES, f.file)), f.sha256, f.file);
  }
});

test('qr-foreign-host: confirm or none accepted, never auto-open, foreign URL must not open (orchestrator decision)', () => {
  const f = main.fixtures.find((x) => x.file === 'qr-foreign-host.png');
  assert.deepEqual([...f.accept].sort(), ['confirm', 'none']);
  assert.equal(f.mustNotAutoOpen, true);
  assert.deepEqual(f.mustNotOpen, ['https://evil.example/cert/12345678']);
  assert.deepEqual(f.mustNotOpenHosts, ['evil.example']);
});

test('security fixtures: busy page and decode bomb are declared', () => {
  assert.ok(main.pages.some((p) => p.kind === 'hostile-busy-loop' && p.page === 'pages/busy.html'));
  const bomb = main.securityFixtures.find((f) => f.finding === 'SEC-04');
  const buf = readFileSync(path.join(FIXTURES, bomb.file));
  assert.equal(buf.toString('ascii', 0, 2), 'BM');
  assert.equal(buf.readInt32LE(18), 16000);
  assert.equal(buf.readInt32LE(22), 16000);
  assert.ok(buf.length < 2048);
});

test('SEC-14 crafted files: JPEG SOF0 (16000x16000) only after the first 64 KiB, file below 256 KiB; GIF 10x10 screen with a 16000x16000 frame', () => {
  const jpeg = main.securityFixtures.find((f) => f.file.endsWith('.jpg') && f.finding === 'SEC-14');
  const gif = main.securityFixtures.find((f) => f.file.endsWith('.gif') && f.finding === 'SEC-14');
  assert.ok(jpeg && gif, 'both SEC-14 fixtures declared');
  const j = readFileSync(path.join(FIXTURES, jpeg.file));
  const at = jpeg.structure.sofOffset;
  assert.deepEqual([j[0], j[1], j[at], j[at + 1]], [0xff, 0xd8, 0xff, 0xc0], 'SOI, then SOF0 at the declared offset');
  assert.equal(j.readUInt16BE(at + 5), 16000);
  assert.equal(j.readUInt16BE(at + 7), 16000);
  assert.ok(at > 64 * 1024, `SOF0 at ${at} is beyond the first 64 KiB`);
  assert.ok(j.length < 256 * 1024, `${j.length} bytes: below the unknown-size limit, so only the deep sniff can refuse it`);
  assert.equal(j.subarray(0, 64 * 1024).filter((b, i, a) => b === 0xff && a[i + 1] >= 0xc0 && a[i + 1] <= 0xc3).length, 0, 'no SOF marker in the first 64 KiB');
  const g = readFileSync(path.join(FIXTURES, gif.file));
  assert.equal(g.toString('ascii', 0, 6), 'GIF89a');
  assert.deepEqual([g.readUInt16LE(6), g.readUInt16LE(8)], [10, 10], 'logical screen 10x10');
  const d = g.indexOf(0x2c, 13 + 6 + 8);
  assert.deepEqual([g.readUInt16LE(d + 5), g.readUInt16LE(d + 7)], [16000, 16000], 'frame 16000x16000');
});

test('SEC-13 hostile page: slab A only as a CSS background, slab B the only <img>; every hiding variant must not auto-open; control auto-opens B', () => {
  const hidden = main.pages.find((p) => p.kind === 'hostile-hidden-image');
  assert.ok(hidden, 'pages/hidden.html declared');
  const html = readFileSync(path.join(FIXTURES, hidden.page), 'utf8');
  assert.equal((html.match(/<img\s/g) ?? []).length, 1, 'one <img> element (slab B)');
  assert.ok(html.includes(`url("../${hidden.background.fixture}")`), 'slab A is a CSS background');
  const a = main.fixtures.find((f) => f.file === hidden.background.fixture);
  const b = main.fixtures.find((f) => f.file === hidden.fixture);
  assert.notEqual(a.expected.number, b.expected.number, 'A and B carry different cert numbers');
  assert.equal(hidden.variants.none.expected.url, `https://www.psacard.com/cert/${b.expected.number}`, 'control opens B');
  assert.deepEqual(hidden.mustNeverOpenUrls, [`https://www.psacard.com/cert/${a.expected.number}`], 'A can never be opened');
  for (const [name, v] of Object.entries(hidden.variants)) {
    if (name === 'none') continue;
    assert.equal(v.expected.mustNotAutoOpen, true, `${name}: must not auto-open`);
  }
  assert.deepEqual(Object.entries(hidden.variants).filter(([, v]) => v.asserted).map(([k]) => k).sort(),
    ['clip-path', 'clipped-parent', 'faint', 'filter-opacity', 'none', 'offscreen', 'opacity0', 'overlay', 'overlay-pe-none', 'visibility'], 'asserted variants: all hiding techniques (SEC-13 + SEC-20) and the control');
});

test('A9 listing page: assets match their hashes; exactly one discoverable slab; page-text numbers are not cert numbers', () => {
  const listing = main.pages.find((p) => p.kind === 'single-slab-listing');
  assert.ok(listing, 'pages/listing.html declared');
  assert.ok(readFileSync(path.join(FIXTURES, listing.page), 'utf8').includes('id="img-slab"'));
  for (const a of main.pageAssets) {
    const p = path.join(FIXTURES, a.file);
    assert.equal(statSync(p).size, a.bytes, a.file);
    assert.equal(sha(p), a.sha256, a.file);
  }
  const disc = listing.images.filter((i) => i.discoverable && !i.addedBy);
  assert.deepEqual(disc.map((i) => i.role).sort(), ['raw-photo', 'slab'], 'default listing: one slab photo + one raw-card photo are slab-sized');
  for (const role of ['logo', 'avatar', 'banner', 'thumbnail']) {
    assert.ok(listing.images.filter((i) => i.role === role).every((i) => !i.discoverable), `${role} below the A9 size threshold`);
  }
  assert.equal(listing.expected.default.url, 'https://www.psacard.com/cert/108114622');
  const slabFixture = main.fixtures.find((f) => f.file === listing.fixture);
  assert.equal(slabFixture.expected.number, listing.expected.default.number);
  for (const n of listing.mustNeverAutoOpenNumbers) assert.notEqual(n, listing.expected.default.number);
});

test('benchmark set: >= 40 fixtures, < 8 MB, hashes match, expectations well-formed', () => {
  assert.ok(bench.fixtures.length >= 40, `${bench.fixtures.length} fixtures`);
  let total = 0;
  for (const f of bench.fixtures) {
    const p = path.join(BENCH, f.file);
    total += statSync(p).size;
    assert.equal(sha(p), f.sha256, f.file);
    assert.ok(['clean', 'degraded', 'negative'].includes(f.category));
    assert.ok(Array.isArray(f.accept) && f.accept.length > 0);
    if (f.expected.number !== null) {
      assert.match(f.expected.number, /^\d{7,13}$/);
      if (f.expected.grader) assert.ok(VALID_LEN[f.expected.grader].includes(f.expected.number.length), `${f.id}: length valid for grader`);
    }
    if (f.category === 'negative') assert.ok(f.mustNotAutoOpen, `${f.id}: negatives must not auto-open`);
  }
  assert.ok(total < 8 * 1024 * 1024, `bench total ${total} bytes`);
  const files = readdirSync(BENCH).filter((x) => /\.(png|jpe?g)$/.test(x));
  assert.equal(files.length, bench.fixtures.length, 'no stray files in bench/');
  const count = (c) => bench.fixtures.filter((f) => f.category === c).length;
  assert.ok(count('clean') >= 15 && count('degraded') >= 25, `clean ${count('clean')}, degraded ${count('degraded')}`);
  const degr = new Set(bench.fixtures.flatMap((f) => f.degradations.map((d) => d.split(':')[0])));
  for (const d of ['jpeg-q40', 'scale-0.5', 'blur-1px', 'blur-2px', 'glare', 'rotate', 'dark-low-contrast', 'busy-art']) assert.ok(degr.has(d), `degradation ${d} covered`);
  const lens = new Set(bench.fixtures.filter((f) => f.expected.number).map((f) => `${f.expected.grader}:${f.expected.number.length}`));
  for (const k of ['psa:7', 'psa:8', 'psa:9', 'cgc-comics:10', 'cgc-cards:10', 'cgc-cards:13']) assert.ok(lens.has(k), `${k} covered`);
  assert.ok(bench.fixtures.some((f) => f.tags.includes('leading-zero') && f.expected.number.length === 9), '9-digit leading zero');
});
