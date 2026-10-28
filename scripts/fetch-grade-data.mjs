#!/usr/bin/env node
// Fetches real card scans for the grade-check benchmark into .cache/grade-data/ (git-ignored; never committed or
// shipped). Source: the Hugging Face dataset jyesr/pokemon-tcg-grading (scans of PSA-graded Pokémon cards, front and
// back, with the PSA grade and cert number). The dataset states no licence and the scans are most likely PSA's own:
// use them locally for testing only.
//
//   node scripts/fetch-grade-data.mjs [--sample tests/bench/real/psa-sample.json] [--pick 200] [--shards 0,1,...]
//   node scripts/fetch-grade-data.mjs --faces
//
// --faces fetches the official card renders listed in tests/bench/official/faces.json (images.pokemontcg.io) into
// .cache/grade-data/official/ for bench:grade --faces. They are the publisher's artwork: local testing only as well.
//
// With an existing sample file it downloads exactly those certs; with --pick N (and no sample file) it first draws a
// new sample, spread over grades, card eras and languages, and writes it. The scans sit in 8 tar archives of about
// 2.15 GB; each archive that holds a sampled cert is read as a stream (curl) and only the sampled files are kept.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://huggingface.co/datasets/jyesr/pokemon-tcg-grading/resolve/main';
export const CACHE = path.join(ROOT, '.cache', 'grade-data', 'psa');
export const FACES_DIR = path.join(ROOT, '.cache', 'grade-data', 'official');
const FACES_LIST = path.join(ROOT, 'tests/bench/official/faces.json');
const SHARDS = 8;

/** curl as a stream (it honours the system proxy and is on every OS); rejects on a non-zero exit. */
function curl(url, { range = null } = {}) {
  const args = ['-sSL', '--fail', '--retry', '3'];
  if (range) args.push('-r', range);
  args.push(url);
  const p = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve, reject) => p.on('close', (code) => (code === 0 || code === 23 ? resolve() : reject(new Error(`curl ${url}: ${code} ${err.trim()}`)))));
  return { stdout: p.stdout, done, kill: () => p.kill() };
}

async function download(url, file) {
  const c = curl(url);
  const out = createWriteStream(file);
  c.stdout.pipe(out);
  await c.done;
  await new Promise((r) => out.on('finish', r));
}

/** Minimal CSV parser (quoted fields, commas and newlines inside quotes). */
export function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; } else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (ch !== '\r') f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** PSA grade label → number ("GEM MT 10" → 10, "NM-MT+ 8.5" → 8.5); null for "AUTHENTIC" and blanks. */
export function gradeNumber(label) {
  const m = /(\d+(?:\.\d)?)\s*(?:\(|$)/.exec(label ?? '');
  return m ? Number(m[1]) : null;
}

const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };

/** A sample of certs (front and back both present), spread over grade buckets, eras and languages. */
export function drawSample(meta, total) {
  const certs = new Map();
  for (const r of meta) {
    const m = /^(\d+)_(front|back)\.jpg$/.exec(r.filename);
    if (!m) continue;
    const c = certs.get(m[1]) ?? { cert: m[1], sides: new Set() };
    c.sides.add(m[2]);
    Object.assign(c, { name: r.card_name, label: r.grade, grade: gradeNumber(r.grade), year: Number(r.year) || null, miscut: /\(MC\)/.test(r.grade) });
    certs.set(m[1], c);
  }
  const pool = [...certs.values()].filter((c) => c.sides.size === 2 && c.grade !== null);
  const bucket = (g) => (g >= 10 ? '10' : g >= 9 ? '9' : g >= 8 ? '8' : g >= 7 ? '7' : g >= 5 ? '5-6' : '1-4');
  const era = (y) => (!y ? 'modern' : y < 2003 ? 'vintage' : y < 2016 ? 'middle' : 'modern');
  const share = { 10: 0.25, 9: 0.2, 8: 0.175, 7: 0.125, '5-6': 0.125, '1-4': 0.125 };
  const out = [];
  // Miscuts first (labelled off-centre by PSA): all of them, up to 5 % of the sample.
  const mc = pool.filter((c) => c.miscut).sort((a, b) => hash(a.cert) - hash(b.cert)).slice(0, Math.round(total * 0.05));
  out.push(...mc);
  for (const [b, f] of Object.entries(share)) {
    const n = Math.round(f * (total - mc.length));
    const cands = pool.filter((c) => !c.miscut && bucket(c.grade) === b).sort((p, q) => hash(p.cert) - hash(q.cert));
    // Within a bucket: round-robin over era × language, so no single kind fills it.
    const groups = new Map();
    for (const c of cands) {
      const k = `${era(c.year)}/${/JAPANESE/.test(c.name) ? 'ja' : 'en'}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const lists = [...groups.values()];
    const picked = [];
    for (let i = 0; picked.length < n && lists.some((l) => l.length); i++) {
      const l = lists[i % lists.length];
      if (l.length) picked.push(l.shift());
    }
    out.push(...picked);
  }
  return out.map((c) => ({ cert: c.cert, grade: c.grade, label: c.label, year: c.year, name: c.name, miscut: c.miscut })).sort((a, b) => (a.cert < b.cert ? -1 : 1));
}

/** First file name in each archive (the archives hold the files in name order, each a contiguous range). */
async function shardStarts() {
  const starts = [];
  for (let i = 0; i < SHARDS; i++) {
    const c = curl(`${REPO}/data_shard_${String(i).padStart(4, '0')}.tar`, { range: '0-511' });
    const chunks = [];
    c.stdout.on('data', (d) => chunks.push(d));
    await c.done;
    const h = Buffer.concat(chunks);
    starts.push(h.subarray(0, 100).toString('latin1').replace(/\0.*$/s, '').split('/').pop());
  }
  return starts;
}

/** Read one archive as a stream and keep the wanted files. Resolves with the names written. */
async function extract(shard, wanted, dir) {
  const c = curl(`${REPO}/data_shard_${String(shard).padStart(4, '0')}.tar`);
  const got = [];
  let buf = Buffer.alloc(0); let need = 0; let skip = 0; let pad = 0; let file = null; let name = null; let left = wanted.size;
  await new Promise((resolve, reject) => {
    c.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (skip) { const k = Math.min(skip, buf.length); skip -= k; buf = buf.subarray(k); if (skip) return; continue; }
        if (file) {
          const k = Math.min(need, buf.length); file.write(buf.subarray(0, k)); need -= k; buf = buf.subarray(k);
          if (need) return;
          file.end(); got.push(name); file = null; left--;
          skip = pad; pad = 0;
          if (!left) { c.kill(); resolve(); return; }
          continue;
        }
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512); buf = buf.subarray(512);
        if (h.every((b) => b === 0)) continue;
        const raw = h.subarray(0, 100).toString('latin1').replace(/\0.*$/s, '');
        const prefix = h.subarray(345, 500).toString('latin1').replace(/\0.*$/s, '');
        const size = parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
        const base = (prefix ? `${prefix}/${raw}` : raw).split('/').pop();
        pad = (512 - (size % 512)) % 512;
        if (h[156] === 48 || h[156] === 0) {
          if (wanted.has(base) && /^\d+_(front|back)\.jpg$/.test(base)) { name = base; need = size; file = createWriteStream(path.join(dir, base)); if (!need) { file.end(); file = null; skip = pad; } continue; }
        }
        skip = size + pad;
      }
    });
    c.stdout.on('end', resolve);
    c.done.catch(reject);
  });
  return got;
}

async function fetchFaces() {
  mkdirSync(FACES_DIR, { recursive: true });
  const { faces } = JSON.parse(readFileSync(FACES_LIST, 'utf8'));
  let n = 0;
  for (const f of faces) {
    const file = path.join(FACES_DIR, `${f.id}.png`);
    if (existsSync(file)) continue;
    await download(f.url, file);
    n++;
  }
  console.log(`${n} card faces fetched, ${faces.length - n} already present → ${path.relative(ROOT, FACES_DIR)}`);
}

async function main() {
  const { values: o } = parseArgs({ options: { sample: { type: 'string', default: path.join(ROOT, 'tests/bench/real/psa-sample.json') }, pick: { type: 'string' }, shards: { type: 'string' }, faces: { type: 'boolean' } } });
  if (o.faces) { await fetchFaces(); return; }
  mkdirSync(path.join(CACHE, 'images'), { recursive: true });
  const metaFile = path.join(CACHE, 'metadata.csv');
  if (!existsSync(metaFile)) { console.log('metadata.csv …'); await download(`${REPO}/metadata.csv`, metaFile); }
  let sample;
  if (existsSync(o.sample) && !o.pick) sample = JSON.parse(readFileSync(o.sample, 'utf8')).certs;
  else {
    const meta = parseCsv(readFileSync(metaFile, 'utf8'));
    sample = drawSample(meta, Number(o.pick ?? 200));
    mkdirSync(path.dirname(o.sample), { recursive: true });
    writeFileSync(o.sample, `${JSON.stringify({ source: 'huggingface.co/datasets/jyesr/pokemon-tcg-grading', note: 'cert numbers and PSA grades only; the scans are fetched by scripts/fetch-grade-data.mjs', certs: sample }, null, 1)}\n`);
    console.log(`drew ${sample.length} certs → ${path.relative(ROOT, o.sample)}`);
  }
  const files = sample.flatMap((c) => [`${c.cert}_front.jpg`, `${c.cert}_back.jpg`]).filter((f) => !existsSync(path.join(CACHE, 'images', f)));
  if (!files.length) { console.log('all scans present'); return; }
  const starts = await shardStarts();
  const shardOf = (f) => { let s = 0; for (let i = 0; i < starts.length; i++) if (f >= starts[i]) s = i; return s; };
  const per = new Map();
  for (const f of files) { const s = shardOf(f); if (!per.has(s)) per.set(s, new Set()); per.get(s).add(f); }
  const only = o.shards ? new Set(o.shards.split(',').map(Number)) : null;
  for (const [s, want] of [...per].sort((a, b) => a[0] - b[0])) {
    if (only && !only.has(s)) continue;
    process.stdout.write(`archive ${s}: ${want.size} files … `);
    const got = await extract(s, want, path.join(CACHE, 'images'));
    console.log(`${got.length} saved`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
