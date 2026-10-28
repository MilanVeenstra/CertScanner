// Gold-label checker for the real-scan grade benchmark (served by scripts/annotate-grade.mjs).
import { homography, applyH } from './geometry.js';

const SIDES = ['left', 'right', 'top', 'bottom'];
const CW = 63; const CH = 88;
const $ = (id) => document.getElementById(id);
let doc = { images: [] }; let rows = []; let cur = -1; let side = 'left'; let img = null; let pix = null; let H = null; let borders = null;

const ratio = (a, b) => (a && b ? `${Math.round((Math.max(a, b) / (a + b)) * 1000) / 10}/${Math.round((Math.min(a, b) / (a + b)) * 1000) / 10}` : '–');

async function load() {
  doc = await (await fetch('/labels')).json();
  applyFilter();
}

function applyFilter() {
  const f = $('filter').value;
  rows = doc.images.filter((r) => f === 'all' || (f === 'unchecked' && r.by !== 'user') || (f === 'review' && r.method === 'review') || (f === 'unusable' && r.status === 'unusable'));
  const list = $('list'); list.textContent = '';
  rows.forEach((r, i) => {
    const li = document.createElement('li');
    li.textContent = `${r.file.replace('.jpg', '')} `;
    const by = document.createElement('span'); by.className = 'by'; by.textContent = `${r.status === 'unusable' ? '✗' : r.by === 'user' ? '✓' : ''} PSA ${r.grade ?? '?'}`;
    li.append(by);
    li.addEventListener('click', () => open(i));
    list.append(li);
  });
  open(0);
}

async function open(i) {
  if (!rows.length) return;
  cur = Math.max(0, Math.min(rows.length - 1, i));
  [...$('list').children].forEach((li, k) => li.setAttribute('aria-current', String(k === cur)));
  const r = rows[cur];
  borders = { ...r.borders };
  $('title').textContent = r.file; $('grade').textContent = `PSA ${r.grade ?? '?'} · ${r.name ?? ''}`; $('note').value = r.note ?? '';
  $('status').textContent = r.status === 'unusable' ? 'Marked unusable.' : r.by === 'user' ? `Checked by you ${r.checked ?? ''}` : `Labelled by ${r.by} (${r.method ?? ''})`;
  img = new Image(); img.src = `/images/${r.file}`;
  try { await img.decode(); } catch { $('status').textContent = 'Scan not downloaded: run node scripts/fetch-grade-data.mjs'; return; }
  const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight); const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  pix = ctx.getImageData(0, 0, c.width, c.height);
  H = homography([[0, 0], [CW, 0], [CW, CH], [0, CH]], r.outer);
  draw();
}

function sample(x, y) {
  const { data, width: W, height: Hh } = pix; const fx = x - 0.5; const fy = y - 0.5;
  if (fx < 0 || fy < 0 || fx > W - 1.001 || fy > Hh - 1.001) return [255, 0, 255];
  const x0 = Math.floor(fx); const y0 = Math.floor(fy); const ax = fx - x0; const ay = fy - y0; const i = (y0 * W + x0) * 4;
  return [0, 1, 2].map((c) => (data[i + c] * (1 - ax) + data[i + 4 + c] * ax) * (1 - ay) + (data[i + W * 4 + c] * (1 - ax) + data[i + W * 4 + 4 + c] * ax) * ay);
}

/** Card-mm point of the zoom strip: depth d (mm, + inward) and position a (mm along the side). */
function stripPoint(s, d, a) {
  if (s === 'left') return [d, a]; if (s === 'right') return [CW - d, a]; if (s === 'top') return [a, d]; return [a, CH - d];
}

const D0 = -1.5; const D1 = 9.5; const LEN = 14;
function draw() {
  const r = rows[cur];
  const cv = $('scan'); const ctx = cv.getContext('2d');
  const k = Math.min(cv.width / img.naturalWidth, cv.height / img.naturalHeight);
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, img.naturalWidth * k, img.naturalHeight * k);
  const P = (u, v) => { const [x, y] = applyH(H, u, v); return [x * k, y * k]; };
  const line = (a, b, color, w = 1.5) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); };
  ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 1.5; ctx.beginPath(); r.outer.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k))); ctx.closePath(); ctx.stroke();
  const b = borders;
  const seg = { left: [P(b.left ?? 0, 0), P(b.left ?? 0, CH)], right: [P(CW - (b.right ?? 0), 0), P(CW - (b.right ?? 0), CH)], top: [P(0, b.top ?? 0), P(CW, b.top ?? 0)], bottom: [P(0, CH - (b.bottom ?? 0)), P(CW, CH - (b.bottom ?? 0))] };
  for (const s of SIDES) if (b[s]) line(...seg[s], s === side ? '#ffd000' : '#00dc3c', s === side ? 2.5 : 1.5);
  // Zoom strip: outside on the left.
  const z = $('zoom'); const zc = z.getContext('2d'); const zi = zc.createImageData(z.width, z.height);
  for (let y = 0; y < z.height; y++) for (let x = 0; x < z.width; x++) {
    const d = D0 + ((x + 0.5) / z.width) * (D1 - D0); const along = side === 'left' || side === 'right' ? CH : CW;
    const a = along / 2 - LEN / 2 + ((y + 0.5) / z.height) * LEN;
    const [u, v] = stripPoint(side, d, a); const [sx, sy] = applyH(H, u, v); const c = sample(sx, sy); const j = (y * z.width + x) * 4;
    zi.data[j] = c[0]; zi.data[j + 1] = c[1]; zi.data[j + 2] = c[2]; zi.data[j + 3] = 255;
  }
  zc.putImageData(zi, 0, 0);
  const X = (mm) => ((mm - D0) / (D1 - D0)) * z.width;
  zc.fillStyle = '#00e5ff'; zc.fillRect(X(0), 0, 1, z.height * 0.12);
  for (let mm = 0; mm <= 9; mm++) { zc.fillStyle = '#fff'; zc.fillRect(X(mm), z.height - (mm % 5 ? 8 : 16), 1, 16); }
  if (b[side]) { zc.fillStyle = '#ffd000'; zc.fillRect(X(b[side]) - 1, 0, 2, z.height); }
  document.querySelectorAll('.sides button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.side === side)));
  $('value').textContent = `${side}: ${b[side] ? `${b[side].toFixed(2)} mm` : 'not set'}`;
  $('ratio').textContent = `L/R ${ratio(b.left, b.right)} · T/B ${ratio(b.top, b.bottom)}`;
}

async function save(status) {
  const r = rows[cur];
  const res = await fetch(`/labels/${r.file}`, { method: 'POST', body: JSON.stringify({ borders, status, note: $('note').value }) });
  if (!res.ok) { $('status').textContent = `Not saved: ${await res.text()}`; return; }
  Object.assign(r, await res.json());
  $('list').children[cur].querySelector('.by').textContent = `${status === 'unusable' ? '✗' : '✓'} PSA ${r.grade ?? '?'}`;
  open(cur + 1);
}

$('zoom').addEventListener('click', (e) => {
  const rect = e.target.getBoundingClientRect();
  const mm = D0 + ((e.clientX - rect.left) / rect.width) * (D1 - D0);
  if (mm > 0.2) { borders[side] = Math.round(mm * 100) / 100; draw(); }
});
document.querySelectorAll('.sides button').forEach((b) => b.addEventListener('click', () => { side = b.dataset.side; draw(); }));
$('ok').addEventListener('click', () => save('ok'));
$('bad').addEventListener('click', () => save('unusable'));
$('next').addEventListener('click', () => open(cur + 1));
$('filter').addEventListener('change', applyFilter);
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key >= '1' && e.key <= '4') { side = SIDES[Number(e.key) - 1]; draw(); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const step = (e.shiftKey ? 0.5 : 0.05) * (e.key === 'ArrowRight' ? 1 : -1);
    borders[side] = Math.max(0.2, Math.round(((borders[side] ?? 2) + step) * 100) / 100); draw(); e.preventDefault();
  } else if (e.key === 'Enter') save('ok'); else if (e.key === 'u' || e.key === 'U') save('unusable');
});
load();
