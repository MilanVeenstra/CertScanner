// Barcode/QR detection (ADR-001 §6). Returns raw text only; parsing happens in core/certParser.js.
// Native BarcodeDetector when it covers every format, else the bundled zxing-wasm reader
// (global ZXingWASM from vendor/zxing/zxing-reader.iife.js). The .wasm is always loaded from the package.

export const FORMATS = Object.freeze(['QRCode', 'Code128', 'Code39', 'DataMatrix', 'ITF']);
const NATIVE = Object.freeze({ qr_code: 'QRCode', code_128: 'Code128', code_39: 'Code39', data_matrix: 'DataMatrix', itf: 'ITF' });
const MAX_TEXT = 4096;
const MAX_SYMBOLS = 4;

let zxingReady = null;

function prepareZxing(getURL) {
  if (!zxingReady) {
    const Z = globalThis.ZXingWASM;
    if (!Z?.prepareZXingModule || !Z.readBarcodes) return Promise.reject(new Error('zxing-missing'));
    const wasmUrl = getURL('vendor/zxing/zxing_reader.wasm');
    zxingReady = Promise.resolve(Z.prepareZXingModule({
      overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? wasmUrl : prefix + p) },
      fireImmediately: true,
    })).catch((e) => { zxingReady = null; throw e; });
  }
  return zxingReady;
}

async function nativeDetector() {
  const BD = globalThis.BarcodeDetector;
  if (typeof BD !== 'function' || typeof BD.getSupportedFormats !== 'function') return null;
  try {
    const supported = await BD.getSupportedFormats();
    if (!Object.keys(NATIVE).every((f) => supported.includes(f))) return null;
    return new BD({ formats: Object.keys(NATIVE) });
  } catch {
    return null;
  }
}

/** Warm the zxing module (no-op when the native detector is used). */
export async function warmUpBarcodes({ getURL = (p) => globalThis.chrome.runtime.getURL(p) } = {}) {
  if (await nativeDetector()) return;
  await prepareZxing(getURL);
}

/**
 * @param {ImageData} imageData
 * @param {{signal?:AbortSignal, getURL?:(p:string)=>string, preferNative?:boolean}} [opts]
 * @returns {Promise<import('../core/types.js').BarcodeRead[]>}
 */
export async function detectBarcodes(imageData, { signal, getURL = (p) => globalThis.chrome.runtime.getURL(p), preferNative = true } = {}) {
  signal?.throwIfAborted();
  const clean = (format, text, engine) => (typeof text === 'string' && text.length > 0
    ? { format: String(format).slice(0, 32), text: text.slice(0, MAX_TEXT), engine } : null);

  const native = preferNative ? await nativeDetector() : null;
  if (native) {
    const found = await native.detect(imageData);
    signal?.throwIfAborted();
    return found.slice(0, MAX_SYMBOLS).map((b) => clean(NATIVE[b.format] ?? b.format, b.rawValue, 'native')).filter(Boolean);
  }
  await prepareZxing(getURL);
  signal?.throwIfAborted();
  const results = await globalThis.ZXingWASM.readBarcodes(imageData, { formats: [...FORMATS], tryHarder: true, maxNumberOfSymbols: MAX_SYMBOLS });
  signal?.throwIfAborted();
  return results.filter((r) => r.isValid !== false).map((r) => clean(r.format, r.text, 'zxing')).filter(Boolean);
}
