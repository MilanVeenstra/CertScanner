// Small panel thumbnails (performance report rec. 1): <= 240 px copies, every intermediate ImageBitmap closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thumbSize, makeThumbBlob, THUMB_MAX_SIDE } from '../../src/sidepanel/thumbs.js';

test('thumbSize: long side <= 240 px, aspect kept, never upscaled', () => {
  assert.equal(THUMB_MAX_SIDE, 240);
  assert.deepEqual(thumbSize(4032, 3024), { width: 240, height: 180 });
  assert.deepEqual(thumbSize(544, 850), { width: 154, height: 240 });
  assert.deepEqual(thumbSize(200, 100), { width: 200, height: 100 });
  assert.deepEqual(thumbSize(12000, 10), { width: 240, height: 1 });
  assert.equal(thumbSize(0, 10), null);
  assert.equal(thumbSize(NaN, 10), null);
  assert.equal(thumbSize(undefined, undefined), null);
});

/** Fakes: createImageBitmap records its options; bitmaps count close(); the canvas returns a small blob. */
function fakes({ drawThrows = false, bitmapDelayMs = 0 } = {}) {
  const bitmaps = [];
  const calls = [];
  return {
    bitmaps,
    calls,
    createImageBitmap: async (blob, opts) => {
      calls.push(opts);
      if (bitmapDelayMs) await new Promise((r) => setTimeout(r, bitmapDelayMs));
      const b = { width: opts.resizeWidth, height: opts.resizeHeight, closed: 0, close() { this.closed++; } };
      bitmaps.push(b);
      return b;
    },
    OffscreenCanvas: class {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return { drawImage: () => { if (drawThrows) throw new Error('draw'); } }; }
      async convertToBlob(o) { return new Blob([new Uint8Array(10)], { type: o.type }); }
    },
  };
}

test('makeThumbBlob decodes straight to the small size (EXIF orientation applied) and closes the bitmap', async () => {
  const f = fakes();
  const out = await makeThumbBlob(new Blob(['x']), { width: 4032, height: 3024 }, f);
  assert.equal(out.type, 'image/png');
  assert.deepEqual(f.calls, [{ imageOrientation: 'from-image', resizeWidth: 240, resizeHeight: 180, resizeQuality: 'medium' }]);
  assert.equal(f.bitmaps.length, 1);
  assert.equal(f.bitmaps[0].closed, 1);
});

test('makeThumbBlob: failures resolve null and still close the bitmap', async () => {
  const f = fakes({ drawThrows: true });
  assert.equal(await makeThumbBlob(new Blob(['x']), { width: 500, height: 800 }, f), null);
  assert.equal(f.bitmaps[0].closed, 1);
  assert.equal(await makeThumbBlob(null, { width: 500, height: 800 }, fakes()), null);
  assert.equal(await makeThumbBlob(new Blob(['x']), { width: 0, height: 800 }, fakes()), null);
  assert.equal(await makeThumbBlob(new Blob(['x']), { width: 500, height: 800 }, { createImageBitmap: undefined, OffscreenCanvas: undefined }), null);
});

test('makeThumbBlob: gives up after the timeout and closes a bitmap that arrives late', async () => {
  const f = fakes({ bitmapDelayMs: 60 });
  const out = await makeThumbBlob(new Blob(['x']), { width: 500, height: 800 }, { ...f, timeoutMs: 10 });
  assert.equal(out, null);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(f.bitmaps.length, 1);
  assert.equal(f.bitmaps[0].closed, 1);
});
