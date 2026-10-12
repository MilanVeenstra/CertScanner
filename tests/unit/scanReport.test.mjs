// "This went wrong" report (ADR A20): pure parts. The ZIP is checked against Node's own CRC-32 and by walking its
// headers the way an unzip tool does; the JSON must hold the scan only (no image address, history or settings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { reportData, reportFileName, imageExtension, zipStore, crc32 } from '../../src/sidepanel/scanReport.js';

const result = {
  jobId: 'job-123', status: 'confirm',
  candidates: [{ grader: null, graderOptions: ['bgs', 'psa'], number: '00123456', confidence: 0.55, source: 'ocr', evidence: ['len:8', 'pass:text', 'incomplete'] }],
  imageInfo: { method: 'capture', resolution: 'screen', width: 400, height: 640, origin: 'https://i.example-shop.com', canRequestSharper: true },
  warnings: [{ code: 'low-resolution' }],
  timings: { acquireMs: 10, preprocessMs: 20, barcodeMs: 5, ocrInitMs: 0, ocrMs: 900, totalMs: 950 },
  labelText: ['BECKETT GRADING SERVICES'],
  passes: [{ pass: 'text', variant: null, label: false, rotation: 0, ms: 310, confidence: 61, text: 'BECKETT GRADING SERVICES 00123456' }],
};

test('reportData: candidates with evidence, timings and per-pass texts; no image address, job id, history or settings', () => {
  const d = reportData(result, { version: '0.1.0', createdAt: '2026-10-12T15:30:00.000Z', image: { file: 'scan-image.jpg', type: 'image/jpeg', bytes: 1234 }, language: 'nl' });
  assert.equal(d.kind, 'certscanner-scan-report');
  assert.deepEqual(d.scan.candidates[0].evidence, ['len:8', 'pass:text', 'incomplete']);
  assert.equal(d.scan.timings.totalMs, 950);
  assert.equal(d.scan.passes[0].text, 'BECKETT GRADING SERVICES 00123456');
  assert.deepEqual(d.scan.imageInfo, { method: 'capture', resolution: 'screen', width: 400, height: 640 });
  const json = JSON.stringify(d);
  for (const absent of ['example-shop', 'job-123', 'history', 'settings', 'autoOpen']) assert.ok(!json.includes(absent), absent);
  assert.match(d.note, /Nothing was sent/);
});

test('reportData tolerates a result without optional parts', () => {
  const d = reportData({ status: 'none', candidates: [], warnings: [] }, { version: '0.1.0', createdAt: 'x', image: null });
  assert.deepEqual(d.scan.passes, []);
  assert.equal(d.scan.imageInfo, null);
  assert.equal(d.scan.timings, null);
});

test('reportFileName and imageExtension', () => {
  assert.equal(reportFileName(new Date(2026, 9, 12, 15, 3, 9)), 'certscanner-report-20261012-150309.zip');
  assert.equal(imageExtension('image/jpeg'), 'jpg');
  assert.equal(imageExtension('image/png'), 'png');
  assert.equal(imageExtension('application/x-evil'), 'img');
});

test('crc32 matches zlib', () => {
  for (const s of ['', 'a', 'CertScanner', 'x'.repeat(1000)]) {
    const b = new TextEncoder().encode(s);
    assert.equal(crc32(b), zlib.crc32(b), s.slice(0, 10));
  }
});

test('zipStore: stored entries an unzip tool can walk (local headers, central directory, end record)', () => {
  const json = new TextEncoder().encode('{"a":1}\n');
  const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const date = new Date(2026, 9, 12, 15, 30, 10);
  const zip = zipStore([{ name: 'scan-report.json', data: json, date }, { name: 'scan-image.jpg', data: img, date }]);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50);
  assert.equal(v.getUint16(eocd + 10, true), 2, 'two entries');
  let cd = v.getUint32(eocd + 16, true);
  const found = [];
  for (let i = 0; i < 2; i++) {
    assert.equal(v.getUint32(cd, true), 0x02014b50);
    const crc = v.getUint32(cd + 16, true);
    const size = v.getUint32(cd + 24, true);
    const nameLen = v.getUint16(cd + 28, true);
    const local = v.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(zip.subarray(cd + 46, cd + 46 + nameLen));
    assert.equal(v.getUint32(local, true), 0x04034b50);
    assert.equal(v.getUint16(local + 8, true), 0, 'stored');
    const data = zip.subarray(local + 30 + v.getUint16(local + 26, true), local + 30 + v.getUint16(local + 26, true) + size);
    assert.equal(zlib.crc32(data), crc);
    found.push([name, Buffer.from(data).toString('hex')]);
    cd += 46 + nameLen;
  }
  assert.deepEqual(found, [['scan-report.json', Buffer.from(json).toString('hex')], ['scan-image.jpg', Buffer.from(img).toString('hex')]]);
});
