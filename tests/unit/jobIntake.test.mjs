import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startJobIntake, parseWindowParam } from '../../src/sidepanel/jobIntake.js';
import { jobKey } from '../../src/shared/jobContract.js';

const NOW = 1_760_000_000_000;
const job = (id, over = {}) => ({
  v: 1, id, createdAt: NOW, source: 'contextMenu', srcUrl: 'https://img.example.com/a.jpg', pageUrl: 'https://shop.example.com/',
  frameUrl: null, frameId: 0, tabId: 1, windowId: 7, mediaType: 'image', ...over,
});

/** Minimal fake of chrome.storage.session + chrome.storage.onChanged. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  const listeners = new Set();
  const emit = (changes) => { for (const l of listeners) l(changes, 'session'); };
  return {
    data,
    area: {
      async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
      async remove(key) { if (key in data) { const old = data[key]; delete data[key]; emit({ [key]: { oldValue: old } }); } },
    },
    onChanged: { addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l) },
    set(key, value) { const old = data[key]; data[key] = value; emit({ [key]: { oldValue: old, newValue: structuredClone(value) } }); },
    listenerCount: () => listeners.size,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('parseWindowParam accepts only 1-10 digit ids', () => {
  assert.equal(parseWindowParam('?w=7'), 7);
  assert.equal(parseWindowParam('?w=1234567890'), 1234567890);
  assert.equal(parseWindowParam('?w=12345678901'), null);
  assert.equal(parseWindowParam('?w=-1'), null);
  assert.equal(parseWindowParam('?w=7x'), null);
  assert.equal(parseWindowParam(''), null);
});

test('a job already stored when the panel loads is consumed once and removed', async () => {
  const s = fakeStorage({ [jobKey(7)]: job('a') });
  const seen = [];
  const intake = startJobIntake({ windowId: 7, onJob: (j) => seen.push(j.id), area: s.area, onChanged: s.onChanged, now: () => NOW });
  await intake.ready;
  await tick();
  assert.deepEqual(seen, ['a']);
  assert.equal(jobKey(7) in s.data, false);
  intake.stop();
  assert.equal(s.listenerCount(), 0);
});

test('jobs written later are delivered via onChanged; newest wins; duplicates ignored', async () => {
  const s = fakeStorage();
  const seen = [];
  const intake = startJobIntake({ windowId: 7, onJob: (j) => seen.push(j.id), area: s.area, onChanged: s.onChanged, now: () => NOW });
  await intake.ready;
  s.set(jobKey(7), job('b'));
  await tick();
  s.set(jobKey(7), job('b')); // same id again (e.g. re-set) -> ignored
  await tick();
  s.set(jobKey(7), job('c'));
  await tick();
  assert.deepEqual(seen, ['b', 'c']);
  intake.stop();
});

test('stale, malformed and other-window jobs are ignored; own stale key is removed', async () => {
  const s = fakeStorage();
  const seen = [];
  const intake = startJobIntake({ windowId: 7, onJob: (j) => seen.push(j.id), area: s.area, onChanged: s.onChanged, now: () => NOW });
  await intake.ready;
  s.set(jobKey(7), job('old', { createdAt: NOW - 10 * 60_000 }));
  await tick();
  assert.equal(jobKey(7) in s.data, false);
  s.set(jobKey(7), { v: 1, id: 'evil', srcUrl: 'javascript:alert(1)' });
  await tick();
  s.set(jobKey(8), job('other', { windowId: 8 }));
  await tick();
  assert.deepEqual(seen, []);
  assert.equal(jobKey(8) in s.data, true);
  intake.stop();
});

test('consumption removes the key only if the stored id still matches', async () => {
  const s = fakeStorage();
  const seen = [];
  const intake = startJobIntake({
    windowId: 7, area: s.area, onChanged: s.onChanged, now: () => NOW,
    onJob: (j) => { seen.push(j.id); if (j.id === 'first') s.data[jobKey(7)] = job('second'); },
  });
  await intake.ready;
  s.set(jobKey(7), job('first'));
  await tick();
  await tick();
  assert.equal(s.data[jobKey(7)]?.id, 'second');
  intake.stop();
});
