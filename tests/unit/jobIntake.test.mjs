import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startJobIntake, parseWindowParam } from '../../src/sidepanel/jobIntake.js';
import { jobKey } from '../../src/shared/jobContract.js';
import { seenJobsKey, parseSeenJobs, addSeenJob, MAX_SEEN_JOBS } from '../../src/shared/seenJobs.js';

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
      async set(items) { for (const [k, v] of Object.entries(items)) { const old = data[k]; data[k] = structuredClone(v); emit({ [k]: { oldValue: old, newValue: structuredClone(v) } }); } },
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

test('a re-delivered job id is skipped and also cleared from the slot (no re-run after a panel reload)', async () => {
  const s = fakeStorage();
  const seen = [];
  const intake = startJobIntake({ windowId: 7, onJob: (j) => seen.push(j.id), area: s.area, onChanged: s.onChanged, now: () => NOW });
  await intake.ready;
  s.set(jobKey(7), job('dup'));
  await tick();
  s.set(jobKey(7), job('dup'));
  await tick();
  await tick();
  assert.deepEqual(seen, ['dup']);
  assert.equal(jobKey(7) in s.data, false);
  intake.stop();
  // A fresh panel (empty `seen`) finds nothing to run.
  const again = [];
  const reloaded = startJobIntake({ windowId: 7, onJob: (j) => again.push(j.id), area: s.area, onChanged: s.onChanged, now: () => NOW });
  await reloaded.ready;
  assert.deepEqual(again, []);
  reloaded.stop();
});

test('page jobs (A9) are delivered through the same slot', async () => {
  const s = fakeStorage();
  const seen = [];
  const intake = startJobIntake({ windowId: 7, onJob: (j) => seen.push(`${j.kind ?? 'image'}:${j.id}`), area: s.area, onChanged: s.onChanged, now: () => NOW });
  await intake.ready;
  s.set(jobKey(7), { v: 1, id: 'p1', createdAt: NOW, kind: 'page', source: 'action', srcUrl: null, pageUrl: 'https://shop.example/x', frameId: 0, tabId: 3, windowId: 7 });
  await tick();
  assert.deepEqual(seen, ['page:p1']);
  assert.equal(jobKey(7) in s.data, false);
  intake.stop();
});

// ---------------------------------------------------------------- O9: consumed ids survive a panel reload

test('O9: a consumed job id is remembered in storage.session; a reloaded panel never re-runs it, even when re-written', async () => {
  const s = fakeStorage();
  const first = [];
  const a = startJobIntake({ windowId: 7, onJob: (j) => first.push(j.id), area: s.area, onChanged: s.onChanged, now: () => NOW });
  await a.ready;
  s.set(jobKey(7), job('page-job-1'));
  await tick(); await tick();
  assert.deepEqual(first, ['page-job-1']);
  assert.deepEqual(s.data[seenJobsKey(7)], ['page-job-1']);
  a.stop(); // panel reload: the in-memory set is gone

  const again = [];
  const b = startJobIntake({ windowId: 7, onJob: (j) => again.push(j.id), area: s.area, onChanged: s.onChanged, now: () => NOW });
  await b.ready;
  s.set(jobKey(7), job('page-job-1')); // same id re-written within the TTL
  await tick(); await tick();
  assert.deepEqual(again, [], 'already handled: no scan, no second tab');
  assert.equal(jobKey(7) in s.data, false, 'slot cleared');
  s.set(jobKey(7), job('page-job-2'));
  await tick(); await tick();
  assert.deepEqual(again, ['page-job-2']);
  assert.deepEqual(s.data[seenJobsKey(7)], ['page-job-1', 'page-job-2']);
  b.stop();
});

test('O9: a job already in the slot when the panel loads is checked against the stored ids first', async () => {
  const s = fakeStorage({ [jobKey(7)]: job('done'), [seenJobsKey(7)]: ['done'] });
  const seen = [];
  const intake = startJobIntake({ windowId: 7, onJob: (j) => seen.push(j.id), area: s.area, onChanged: s.onChanged, now: () => NOW });
  await intake.ready;
  await tick();
  assert.deepEqual(seen, []);
  assert.equal(jobKey(7) in s.data, false);
  intake.stop();
});

test('O9: seen-job list is validated and capped (newest kept)', () => {
  assert.deepEqual(parseSeenJobs(null), []);
  assert.deepEqual(parseSeenJobs(['a', 5, '', 'x'.repeat(65), 'a', 'b']), ['a', 'b']);
  let list = [];
  for (let i = 0; i < MAX_SEEN_JOBS + 5; i++) list = addSeenJob(list, `id-${i}`);
  assert.equal(list.length, MAX_SEEN_JOBS);
  assert.equal(list[0], 'id-5');
  assert.equal(list.at(-1), `id-${MAX_SEEN_JOBS + 4}`);
  assert.deepEqual(addSeenJob(['a', 'b'], 'a'), ['b', 'a']);
  assert.deepEqual(addSeenJob(['a'], ''), ['a']);
});
