// OCR engine lifecycle (performance report rec. 3a): a scan that is cancelled or times out while a recognize call is
// running terminates the worker, so the next scan starts a fresh one instead of waiting for the orphaned call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOcrEngine } from '../../src/pipeline/ocr.js';

/** Fake tesseract.js: workers whose recognize() resolves after `recognizeMs` (or never with Infinity). */
function fakeTesseract({ recognizeMs = 5 } = {}) {
  const workers = [];
  return {
    workers,
    createWorker: async () => {
      const w = {
        id: workers.length,
        terminated: false,
        recognizeCalls: 0,
        setParameters: async () => {},
        recognize: () => {
          w.recognizeCalls++;
          if (recognizeMs === Infinity) return new Promise(() => {});
          return new Promise((r) => setTimeout(() => r({ data: { text: `w${w.id}`, confidence: 90, blocks: [] } }), recognizeMs));
        },
        terminate: async () => { w.terminated = true; },
      };
      workers.push(w);
      return w;
    },
  };
}
const engine = (T, over = {}) => createOcrEngine({ getURL: (p) => `chrome-extension://x/${p}`, Tesseract: T, idleMs: 60_000, ...over });

test('a finished recognize keeps the worker for the next call', async () => {
  const T = fakeTesseract();
  const ocr = engine(T);
  const a = await ocr.recognizeText(new Blob(['x']));
  const b = await ocr.recognizeText(new Blob(['x']));
  assert.equal(a.text, 'w0');
  assert.equal(b.text, 'w0');
  assert.equal(T.workers.length, 1);
  assert.equal(ocr.terminations, 0);
  await ocr.dispose();
});

test('Cancel mid-recognize terminates the worker at once; the next call gets a fresh worker without waiting', async () => {
  const T = fakeTesseract({ recognizeMs: Infinity });
  const ocr = engine(T);
  const ctl = new AbortController();
  const p = ocr.recognizeText(new Blob(['x']), { signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(T.workers[0].recognizeCalls, 1);
  const t0 = Date.now();
  ctl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.ok(Date.now() - t0 < 100);
  assert.equal(T.workers[0].terminated, true);
  assert.equal(ocr.terminations, 1);
  assert.equal(ocr.ready, false);
  // The stuck call never settles, yet the queue moves on with a new worker.
  const fast = fakeTesseract({ recognizeMs: 5 });
  T.createWorker = fast.createWorker;
  const next = await ocr.recognizeText(new Blob(['x']));
  assert.equal(next.text, 'w0'); // first worker of the replacement factory
  assert.equal(fast.workers.length, 1);
  await ocr.dispose();
});

test('a scan timeout (TimeoutError signal) mid-recognize also terminates the worker', async () => {
  const T = fakeTesseract({ recognizeMs: Infinity });
  const ocr = engine(T);
  const keepAlive = setTimeout(() => {}, 500); // Node unrefs AbortSignal.timeout timers
  try {
    await assert.rejects(ocr.recognizeDigits(new Blob(['x']), { signal: AbortSignal.timeout(20) }), (e) => e.name === 'TimeoutError');
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(T.workers[0].terminated, true);
  assert.equal(ocr.terminations, 1);
});

test('an abort while the call is only queued does not terminate the busy worker of another scan', async () => {
  const T = fakeTesseract({ recognizeMs: 40 });
  const ocr = engine(T);
  const other = ocr.recognizeText(new Blob(['x']));
  const ctl = new AbortController();
  const queued = ocr.recognizeText(new Blob(['x']), { signal: ctl.signal });
  ctl.abort();
  await assert.rejects(queued, (e) => e.name === 'AbortError');
  assert.equal((await other).text, 'w0');
  assert.equal(T.workers[0].terminated, false);
  assert.equal(ocr.terminations, 0);
  await ocr.dispose();
});

test('a worker that finishes starting after dispose() is terminated, not kept', async () => {
  let release;
  const w = { terminated: false, setParameters: async () => {}, recognize: async () => ({ data: {} }), terminate: async () => { w.terminated = true; } };
  const T = { createWorker: () => new Promise((r) => { release = () => r(w); }) };
  const ocr = engine(T);
  const warm = ocr.warmUp();
  await new Promise((r) => setTimeout(r, 5));
  await ocr.dispose();
  release();
  await assert.rejects(warm, (e) => e.code === 'disposed');
  assert.equal(w.terminated, true);
  assert.equal(ocr.ready, false);
});

test('a Blob is handed to tesseract.js as bytes, so a terminate() during its async Blob read cannot hit a null worker', async () => {
  const T = fakeTesseract();
  const seen = [];
  const create = T.createWorker;
  T.createWorker = async (...a) => {
    const w = await create(...a);
    const rec = w.recognize;
    w.recognize = (image, ...rest) => { seen.push(image); return rec(image, ...rest); };
    return w;
  };
  const ocr = engine(T);
  await ocr.recognizeText(new Blob([new Uint8Array([1, 2, 3])]));
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof Uint8Array, 'recognize() receives a Uint8Array, not a Blob');
  assert.deepEqual([...seen[0]], [1, 2, 3]);
  await ocr.dispose();
});
