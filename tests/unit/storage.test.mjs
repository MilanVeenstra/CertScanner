import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, migrateSettings, applySettingsPatch } from '../../src/shared/settings.js';
import { MAX_HISTORY, migrateHistory, addEntry, makeEntry } from '../../src/shared/history.js';

test('settings defaults', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { v: 1, autoOpen: true, openInBackground: false, saveHistory: true, scanOnToolbarClick: true });
});

test('migrateSettings: missing or invalid -> defaults, nothing written', () => {
  for (const raw of [undefined, null, 5, 'x', [], {}, { v: 0 }, { v: '1' }, { v: -1 }, { v: 1.5 }]) {
    assert.deepEqual(migrateSettings(raw), { value: DEFAULT_SETTINGS, needsWrite: false }, JSON.stringify(raw));
  }
});

test('migrateSettings: v1 reads known booleans, ignores bad types', () => {
  assert.deepEqual(migrateSettings({ v: 1, autoOpen: false, openInBackground: true, saveHistory: false }),
    { value: { v: 1, autoOpen: false, openInBackground: true, saveHistory: false, scanOnToolbarClick: true }, needsWrite: false });
  assert.deepEqual(migrateSettings({ v: 1, autoOpen: 'no', saveHistory: 0 }).value, DEFAULT_SETTINGS);
});

test('migrateSettings: newer version reads known fields and never writes back', () => {
  const r = migrateSettings({ v: 3, autoOpen: false, futureThing: { a: 1 } });
  assert.equal(r.value.autoOpen, false);
  assert.equal(r.needsWrite, false);
  assert.equal('futureThing' in r.value, false);
});

test('applySettingsPatch keeps newer-version fields and validates the patch', () => {
  assert.deepEqual(applySettingsPatch(undefined, { autoOpen: false }), { v: 1, autoOpen: false, openInBackground: false, saveHistory: true, scanOnToolbarClick: true });
  const newer = applySettingsPatch({ v: 3, autoOpen: true, futureThing: 1 }, { openInBackground: true });
  assert.deepEqual(newer, { v: 3, autoOpen: true, openInBackground: true, saveHistory: true, scanOnToolbarClick: true, futureThing: 1 });
  assert.throws(() => applySettingsPatch(undefined, { autoOpen: 'yes' }), TypeError);
  assert.throws(() => applySettingsPatch(undefined, { evil: true }), TypeError);
});

const entry = (over = {}) => ({ grader: 'psa', number: '01234567', at: 1_760_000_000_000, source: 'ocr', pageHost: 'www.ebay.com', ...over });

test('migrateHistory: missing/invalid -> empty, nothing written', () => {
  for (const raw of [undefined, null, 'x', [], {}, { v: 1 }, { v: 1, entries: 'x' }]) {
    assert.deepEqual(migrateHistory(raw), { value: { v: 1, entries: [] }, needsWrite: false }, JSON.stringify(raw));
  }
});

test('migrateHistory: drops bad entries individually and asks for a write', () => {
  const raw = {
    v: 1,
    entries: [
      entry(),
      entry({ grader: 'bgs' }),
      entry({ number: '123' }),
      entry({ number: '1401036622258' }), // 13 digits is not PSA
      entry({ at: 'yesterday' }),
      entry({ source: 'web' }),
      entry({ pageHost: '<script>' }),
      entry({ grader: 'cgc-cards', number: '1401036622258', pageHost: null, source: 'manual' }),
      null,
    ],
  };
  const r = migrateHistory(raw);
  assert.equal(r.needsWrite, true);
  assert.deepEqual(r.value.entries.map((e) => e.number), ['01234567', '1401036622258']);
  assert.deepEqual(migrateHistory({ v: 1, entries: [entry()] }).needsWrite, false);
});

test('migrateHistory: newer version is read but never written back', () => {
  const r = migrateHistory({ v: 2, entries: [entry(), { weird: true }] });
  assert.equal(r.needsWrite, false);
  assert.equal(r.value.entries.length, 1);
});

test('addEntry: newest first, dedupe on grader+number, cap 25', () => {
  let h = { v: 1, entries: [] };
  for (let i = 0; i < 30; i++) h = addEntry(h, entry({ number: String(10_000_000 + i), at: 1_760_000_000_000 + i }));
  assert.equal(h.entries.length, MAX_HISTORY);
  assert.equal(MAX_HISTORY, 25);
  assert.equal(h.entries[0].number, '10000029');
  h = addEntry(h, entry({ number: '10000010', at: 1_770_000_000_000 }));
  assert.equal(h.entries[0].number, '10000010');
  assert.equal(h.entries.filter((e) => e.number === '10000010').length, 1);
  // Same number, different grader is a separate entry
  const two = addEntry(addEntry({ v: 1, entries: [] }, entry({ grader: 'cgc-comics', number: '4012345001' })), entry({ grader: 'cgc-cards', number: '4012345001' }));
  assert.equal(two.entries.length, 2);
  assert.throws(() => addEntry(h, entry({ number: 'abc' })), TypeError);
});

test('makeEntry builds a minimal entry (no URLs, no host, no image data)', () => {
  const e = makeEntry({ grader: 'psa', number: '01234567', source: 'ocr' }, 'https://www.ebay.com/itm/1?x=y', 1_760_000_000_000);
  assert.deepEqual(e, { grader: 'psa', number: '01234567', at: 1_760_000_000_000, source: 'ocr', pageHost: null });
  assert.equal(makeEntry({ grader: 'psa', number: '01234567', source: 'manual' }, null, 1).pageHost, null);
});

test('replaceLatest swaps the newest entry for a correction (J12), count unchanged', async () => {
  const { replaceLatest } = await import('../../src/shared/history.js');
  let h = { v: 1, entries: [] };
  h = addEntry(h, entry({ number: '11111111', at: 1 }));
  h = addEntry(h, entry({ number: '01234547', at: 2 })); // wrong auto-open
  const fixed = replaceLatest(h, entry({ number: '01234567', at: 3, source: 'manual' }));
  assert.deepEqual(fixed.entries.map((e) => e.number), ['01234567', '11111111']);
  // Correction equal to an older entry: deduped, still no growth
  const dup = replaceLatest(h, entry({ number: '11111111', at: 4 }));
  assert.deepEqual(dup.entries.map((e) => e.number), ['11111111']);
  // Empty history: behaves like addEntry
  assert.equal(replaceLatest({ v: 1, entries: [] }, entry()).entries.length, 1);
});

test('makeEntry never stores the page host (spec R-09: grader, number, method, time only)', () => {
  const e = makeEntry({ grader: 'psa', number: '01234567', source: 'ocr' }, 'https://www.ebay.com/itm/1', 5);
  assert.equal(e.pageHost, null);
});

test('A9 setting scanOnToolbarClick: default true, tolerant read, patchable', () => {
  assert.equal(DEFAULT_SETTINGS.scanOnToolbarClick, true);
  assert.equal(migrateSettings({ v: 1, scanOnToolbarClick: false }).value.scanOnToolbarClick, false);
  assert.equal(migrateSettings({ v: 1, scanOnToolbarClick: 'no' }).value.scanOnToolbarClick, true);
  assert.equal(migrateSettings({ v: 1, autoOpen: false }).value.scanOnToolbarClick, true); // older stored settings
  assert.equal(applySettingsPatch(undefined, { scanOnToolbarClick: false }).scanOnToolbarClick, false);
});
