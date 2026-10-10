// Small thumbnails for the side panel (performance report rec. 1). The preview and the page-result rows show a
// downscaled copy (long side <= 240 px) instead of the full photo, so the renderer's image-decode cache never holds
// full-resolution decodes (one 12 MP photo = 46.5 MiB). The full image is decoded only for "Show larger".
// No chrome APIs; the canvas/bitmap functions are injectable for unit tests.

export const THUMB_MAX_SIDE = 240;
export const THUMB_TIMEOUT_MS = 3000;

/** Target size for a w x h image whose long side must be <= max (never upscales). null for unusable sizes. */
export function thumbSize(width, height, max = THUMB_MAX_SIDE) {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1)) return null;
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Downscaled PNG copy of an image blob. `size` is the decoded (EXIF-oriented) size the scanner reported.
 * Every intermediate ImageBitmap is closed, also on failure. Resolves null when the copy can't be made in time.
 * @param {Blob} blob
 * @param {{width:number, height:number}} size
 * @param {{max?:number, timeoutMs?:number, createImageBitmap?:typeof globalThis.createImageBitmap,
 *   OffscreenCanvas?:typeof globalThis.OffscreenCanvas}} [opts]
 * @returns {Promise<Blob|null>}
 */
export async function makeThumbBlob(blob, size, {
  max = THUMB_MAX_SIDE, timeoutMs = THUMB_TIMEOUT_MS,
  createImageBitmap: cib = globalThis.createImageBitmap, OffscreenCanvas: Canvas = globalThis.OffscreenCanvas,
} = {}) {
  const target = thumbSize(size?.width, size?.height, max);
  if (!blob || !target || typeof cib !== 'function' || typeof Canvas !== 'function') return null;
  let timer;
  let timedOut = false;
  const work = (async () => {
    let bitmap = null;
    try {
      bitmap = await cib(blob, { imageOrientation: 'from-image', resizeWidth: target.width, resizeHeight: target.height, resizeQuality: 'medium' });
      if (timedOut) return null;
      const canvas = new Canvas(target.width, target.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, target.width, target.height);
      bitmap.close();
      bitmap = null;
      return await canvas.convertToBlob({ type: 'image/png' });
    } catch {
      return null;
    } finally {
      try { bitmap?.close(); } catch { /* closed */ }
    }
  })();
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
