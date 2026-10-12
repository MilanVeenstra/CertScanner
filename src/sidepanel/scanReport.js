// "This went wrong" (ADR A20): one local .zip with the scanned photo and what the scan read, saved through the
// browser's own download (an <a download> link to an object URL, no extra permission). Nothing is sent anywhere.
// Only the scan itself goes in: no history, settings, page address or image address. Pure; main.js does the click.

export const REPORT_VERSION = 1;
const MAX_PASSES = 16;
const MAX_TEXT = 200;

const str = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The report's JSON: the ScanResult's candidates (with evidence), warnings, timings, label lines and per-pass texts.
 * @param {import('../core/types.js').ScanResult} result
 * @param {{version:string, createdAt:string, image:{file:string, type:string, bytes:number}|null, language?:string}} meta
 */
export function reportData(result, { version, createdAt, image, language = '' }) {
  const info = result?.imageInfo;
  return {
    kind: 'certscanner-scan-report',
    v: REPORT_VERSION,
    extensionVersion: str(version, 32),
    createdAt: str(createdAt, 40),
    language: str(language, 16),
    note: 'Saved on this computer from the CertScanner panel. Nothing was sent anywhere.',
    image,
    scan: {
      status: str(result?.status, 16),
      error: result?.error?.code ? { code: str(result.error.code, 40) } : null,
      // The image's size and how it was obtained; its address (origin) is left out.
      imageInfo: info ? { method: str(info.method, 20), resolution: str(info.resolution, 10), width: num(info.width), height: num(info.height) } : null,
      candidates: (result?.candidates ?? []).slice(0, 5).map((c) => ({
        number: str(c.number, 13), grader: str(c.grader, 16), graderOptions: (c.graderOptions ?? []).map((g) => str(g, 16)),
        confidence: num(c.confidence), source: str(c.source, 16), evidence: (c.evidence ?? []).slice(0, 40).map((e) => str(e, 80)),
      })),
      warnings: (result?.warnings ?? []).slice(0, 8).map((w) => ({ code: str(w.code, 40), ...(w.detail ? { detail: str(w.detail, 80) } : {}) })),
      timings: result?.timings ? Object.fromEntries(Object.entries(result.timings).map(([k, v]) => [k, num(v)])) : null,
      labelText: (result?.labelText ?? []).slice(0, 24).map((l) => str(l, 80)),
      passes: (result?.passes ?? []).slice(0, MAX_PASSES).map((p) => ({
        pass: str(p.pass, 10), variant: str(p.variant, 16), label: p.label === true, rotation: num(p.rotation),
        ms: num(p.ms), confidence: num(p.confidence), text: str(p.text),
      })),
    },
  };
}

const IMAGE_EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif' });
/** File extension for the photo inside the report. */
export const imageExtension = (type) => IMAGE_EXT[type] ?? 'img';

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** "certscanner-report-20261012-153000.zip" (local time, as the user saw it). */
export function reportFileName(date) {
  return `certscanner-report-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`;
}

let crcTable = null;
/** CRC-32 (IEEE 802.3), as ZIP requires. */
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS time/date fields of a local Date (ZIP's 2-second resolution, years 1980-2107). */
function dosDateTime(d) {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * A ZIP archive with the files stored (no compression: the photo is compressed already and the JSON is small).
 * @param {{name:string, data:Uint8Array, date:Date}[]} files names are plain ASCII
 * @returns {Uint8Array}
 */
export function zipStore(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ name: enc.encode(f.name), data: f.data, crc: crc32(f.data), ...dosDateTime(f.date) }));
  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v) => { view.setUint32(at, v >>> 0, true); at += 4; };
  const bytes = (b) => { out.set(b, at); at += b.length; };
  const offsets = [];
  for (const e of entries) {
    offsets.push(at);
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(e.time); u16(e.date);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0);
    bytes(e.name); bytes(e.data);
  }
  const centralAt = at;
  entries.forEach((e, i) => {
    u32(0x02014b50); u16(20); u16(20); u16(0); u16(0); u16(e.time); u16(e.date);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(offsets[i]);
    bytes(e.name);
  });
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length); u32(centralSize); u32(centralAt); u16(0);
  return out;
}
