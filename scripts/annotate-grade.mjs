#!/usr/bin/env node
// Local page for checking and correcting the gold border labels of the real-scan benchmark
// (tests/bench/real/psa-labels.json; scans in .cache/grade-data/psa/images, see scripts/fetch-grade-data.mjs).
//   npm run annotate:grade   → http://127.0.0.1:8765
// Listens on 127.0.0.1 only. Writes only the labels file.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABELS = path.join(ROOT, 'tests/bench/real/psa-labels.json');
const IMAGES = path.join(ROOT, '.cache/grade-data/psa/images');
const PORT = Number(process.env.PORT ?? 8765);
const STATIC = {
  '/': ['tools/grade-annotate/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['tools/grade-annotate/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['tools/grade-annotate/style.css', 'text/css; charset=utf-8'],
  '/geometry.js': ['src/pipeline/grade/geometry.js', 'text/javascript; charset=utf-8'],
};

const send = (res, code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };

function readLabels() { return existsSync(LABELS) ? JSON.parse(readFileSync(LABELS, 'utf8')) : { images: [] }; }
function writeLabels(doc) { const tmp = `${LABELS}.tmp`; writeFileSync(tmp, `${JSON.stringify(doc, null, 1)}\n`); renameSync(tmp, LABELS); }

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return send(res, 200, readFileSync(path.join(ROOT, file)), type);
  }
  if (req.method === 'GET' && url.pathname === '/labels') return send(res, 200, JSON.stringify(readLabels()), 'application/json');
  const img = /^\/images\/(\d+_(?:front|back)\.jpg)$/.exec(url.pathname);
  if (req.method === 'GET' && img) {
    const file = path.join(IMAGES, img[1]);
    return existsSync(file) ? send(res, 200, readFileSync(file), 'image/jpeg') : send(res, 404, 'scan not downloaded: run node scripts/fetch-grade-data.mjs');
  }
  const put = /^\/labels\/(\d+_(?:front|back)\.jpg)$/.exec(url.pathname);
  if (req.method === 'POST' && put) {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let upd;
      try { upd = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
      const doc = readLabels();
      const row = doc.images.find((r) => r.file === put[1]);
      if (!row) return send(res, 404, 'no such label');
      const okNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 15;
      if (upd.borders && !['left', 'right', 'top', 'bottom'].every((k) => upd.borders[k] === null || okNum(upd.borders[k]))) return send(res, 400, 'bad borders');
      if (upd.status && !['ok', 'unusable'].includes(upd.status)) return send(res, 400, 'bad status');
      if (upd.borders) row.borders = upd.borders;
      if (upd.status) row.status = upd.status;
      if (typeof upd.note === 'string') row.note = upd.note.slice(0, 300);
      row.by = 'user';
      row.checked = new Date().toISOString().slice(0, 10);
      writeLabels(doc);
      return send(res, 200, JSON.stringify(row), 'application/json');
    });
    return undefined;
  }
  return send(res, 404, 'not found');
});
server.listen(PORT, '127.0.0.1', () => console.log(`grade labels: http://127.0.0.1:${PORT}  (Ctrl+C to stop)`));
