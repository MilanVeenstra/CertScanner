#!/usr/bin/env node
/**
 * CertScanner synthetic test-fixture generator.
 *
 * Renders plain HTML/CSS "slabs" (plastic case + label band + card/comic area) in Playwright's
 * bundled Chromium, screenshots them, derives low-res / rotated variants with <canvas>, writes
 * tests/fixtures/manifest.json plus the e2e pages under tests/fixtures/pages/, then verifies the
 * output (dimensions, size budget, hashes, zxing-wasm barcode decode, gallery page loading).
 *
 * Everything is synthetic: grader names are plain text as a label would print them; there are no
 * logos, trademark artwork or real card/comic images. All values are fixed, so the output is
 * byte-stable for a given Chromium build + installed fonts (see manifest.environment).
 *
 * It also writes the A9 page-scan listing (tests/fixtures/pages/listing.html + pages/assets/*.png): one slab photo,
 * small logo/avatar/banner images and page text with non-cert numbers (price, item number, seller ID).
 *
 * Security fixtures: pages/busy.html (SEC-03), security/decode-bomb-rle8.bmp (SEC-04), pages/hidden.html (SEC-13:
 * slab A as a CSS background, slab B's <img> hidden in several ways) and two SEC-14 crafted files
 * (security/jpeg-sof-after-64k.jpg, security/gif-frame-larger-than-screen.gif).
 *
 * It also writes the OCR benchmark set (ADR-001 §14, D3 gate) to tests/fixtures/bench/ with its own
 * bench-manifest.json: clean renders with varied cert numbers plus deterministic degradations
 * (JPEG q40, 0.5x scale, 1-2 px blur, glare, rotation, dark/low contrast, busy art with other digits).
 * Degradations use only canvas operations and a seeded PRNG, so they are byte-stable too.
 *
 * Usage:
 *   node scripts/gen-fixtures.mjs                 generate into tests/fixtures (+ bench/), then verify
 *   node scripts/gen-fixtures.mjs --verify-only   verify the existing fixtures only
 *   node scripts/gen-fixtures.mjs --no-verify     generate without verifying
 *   node scripts/gen-fixtures.mjs --no-bench      skip the benchmark set (generate and verify)
 *   node scripts/gen-fixtures.mjs --out <dir>     write somewhere else (e.g. byte-stability check)
 *
 * Env: CERTSCANNER_CHROMIUM=<path to chrome>  (default: /opt/pw-browsers/chromium-1194/chrome-linux/chrome
 *      if present, otherwise Playwright's own bundled Chromium).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bwipjs from 'bwip-js/node';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'tests', 'fixtures');
const DEFAULT_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MAX_BYTES = 400 * 1024;
const BACKDROP = '#e6e3dc';
const LABEL_FONT = '"Liberation Sans", Arial, Helvetica, sans-serif';
const ZXING_IIFE = path.join(ROOT, 'node_modules', 'zxing-wasm', 'dist', 'iife', 'reader', 'index.js');
const ZXING_WASM = path.join(ROOT, 'node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm');
const BENCH_SUBDIR = 'bench';
const BENCH_MAX_TOTAL = 8 * 1024 * 1024;
const EVALUATION_RULE = 'A run passes a fixture when the observed status is in (accept ?? [expected.status]); when expected.number is non-null the top candidate must equal it exactly (string compare, leading zeros kept); when expected.grader is non-null the routed grader must equal it (a confirm result with an unresolved grader is reported separately, an auto-open with a different grader is a wrong auto-open); when graderUnresolved is true no grader may be pre-selected; mustNotAutoOpen fixtures must never auto-open; mustNotOpen URLs/hosts must never be navigated to or requested.';

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, generate: true, verify: true, bench: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify-only') opts.generate = false;
    else if (a === '--no-verify') opts.verify = false;
    else if (a === '--no-bench') opts.bench = false;
    else if (a === '--out') opts.out = path.resolve(argv[++i] ?? '');
    else if (a.startsWith('--out=')) opts.out = path.resolve(a.slice(6));
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/gen-fixtures.mjs [--out <dir>] [--verify-only | --no-verify] [--no-bench]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.generate && !opts.verify) throw new Error('--verify-only and --no-verify are exclusive');
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const dataUrl = (buf, type = 'image/png') => `data:${type};base64,${buf.toString('base64')}`;

/** Width/height from a PNG IHDR or a JPEG SOFn marker. */
function imageSize(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), type: 'image/jpeg' };
      }
      i += 2 + len;
    }
  }
  throw new Error('Unsupported image format');
}

function chromeExecutable() {
  if (process.env.CERTSCANNER_CHROMIUM) return process.env.CERTSCANNER_CHROMIUM;
  return existsSync(DEFAULT_CHROME) ? DEFAULT_CHROME : undefined; // undefined → Playwright default
}

async function launchBrowser() {
  return chromium.launch({
    executablePath: chromeExecutable(),
    headless: true,
    // Software raster + fixed colour profile/hinting keep pixels (and therefore PNG bytes) stable.
    args: ['--disable-gpu', '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text',
      '--force-device-scale-factor=1'],
  });
}

async function newContext(browser, viewport = { width: 1400, height: 1800 }) {
  return browser.newContext({
    viewport, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce',
    timezoneId: 'UTC',
  });
}

// ---------------------------------------------------------------------------------------------
// Barcodes (bwip-js). Module sizes are exact integers at natural image size.
// ---------------------------------------------------------------------------------------------
const PSA_BACK_CERT = '81234567';
const CGC_QR_URL = 'https://www.cgccomics.com/certlookup/4012347003/';
const FOREIGN_QR_URL = 'https://evil.example/cert/12345678';

async function makeBarcodes() {
  // code128: scale = module width in px. 3 px modules, height 12 mm (~102 px), no HRI text (printed in HTML).
  const code128 = await bwipjs.toBuffer({ bcid: 'code128', text: PSA_BACK_CERT, scale: 3, height: 12, includetext: false });
  // qrcode: bwip-js draws 2 px per module per scale unit → scale 2 = 4 px modules. ECC level M.
  const cgcQr = await bwipjs.toBuffer({ bcid: 'qrcode', text: CGC_QR_URL, scale: 2, eclevel: 'M' });
  const foreignQr = await bwipjs.toBuffer({ bcid: 'qrcode', text: FOREIGN_QR_URL, scale: 2, eclevel: 'M' });
  return { code128, cgcQr, foreignQr };
}

// ---------------------------------------------------------------------------------------------
// HTML / CSS building blocks
// ---------------------------------------------------------------------------------------------
const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:${BACKDROP}}
body{font-family:${LABEL_FONT};color:#111;-webkit-font-smoothing:antialiased}
#shot{display:inline-block;padding:20px;background:${BACKDROP}}
.slab{position:relative;border-radius:16px;border:2px solid #a9b1b9;padding:20px 22px 26px;
  background:linear-gradient(160deg,#f5f8fa 0%,#dfe5ea 55%,#eef2f5 100%);
  box-shadow:inset 0 0 0 6px rgba(255,255,255,.55),inset 0 0 0 7px #c3cad1}
.slab.card-slab{width:504px}
.slab.comic-slab{width:640px}
.window{margin-top:18px;border-radius:6px;padding:10px;background:#cfd6dc;box-shadow:inset 0 0 0 2px #b7c0c8;
  display:flex;justify-content:center}
.bar{display:block;height:10px;border-radius:5px;background:rgba(0,0,0,.5)}
.bar.light{background:rgba(255,255,255,.75)}
.w30{width:30%}.w40{width:40%}.w50{width:50%}.w60{width:60%}.w70{width:70%}.w80{width:80%}.w90{width:90%}
.label{border-radius:4px;background:#fff}
.code{display:block;image-rendering:pixelated}

/* PSA-style front/back label (synthetic): white label, red frame, plain-text brand. */
.psa-label{height:136px;border:5px solid #c8102e;display:flex;justify-content:space-between;padding:12px 16px}
.psa-label .left{display:flex;flex-direction:column;justify-content:space-between;font-weight:700;font-size:19px;
  letter-spacing:.3px;white-space:nowrap;min-width:0}
.psa-label .right{display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;text-align:right}
.psa-label .grade{font-weight:700;font-size:20px}
.psa-brand{color:#c8102e;font-weight:700;font-size:26px;letter-spacing:1px}
.psa-label .cert{font-weight:700;font-size:22px;letter-spacing:1.5px}
.psa-back{border:5px solid #c8102e;padding:8px 16px 10px;display:flex;flex-direction:column;align-items:center}
.psa-back .top{align-self:stretch;display:flex;justify-content:space-between;align-items:center;height:30px}
.psa-back .quiet{padding:6px 36px 4px;background:#fff}
.psa-back .cert{font-weight:700;font-size:20px;letter-spacing:3px;margin-top:2px}

/* CGC-style comic label (synthetic): blue band, white grade box and info box, plain-text brand. */
.cgc-label{height:184px;background:#1d4f9e;display:flex;gap:12px;padding:12px;color:#fff}
.cgc-left{width:116px;display:flex;flex-direction:column;align-items:center;gap:6px}
.cgc-brand{font-weight:700;font-size:30px;letter-spacing:3px;line-height:1}
.cgc-gradebox{background:#fff;color:#111;width:108px;border-radius:3px;text-align:center;padding:8px 4px 6px}
.cgc-grade{font-size:42px;font-weight:700;line-height:1}
.cgc-pages{font-size:13px;font-weight:700;letter-spacing:.5px;text-align:center;line-height:1.15}
.cgc-info{flex:1;background:#fff;color:#111;border-radius:3px;padding:10px 14px;display:flex;flex-direction:column;
  gap:7px;min-width:0}
.cgc-info .row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.cgc-universal{font-size:15px;font-weight:700;letter-spacing:2px;color:#1d4f9e;white-space:nowrap}
.cgc-cert{font-size:20px;font-weight:700;letter-spacing:1.5px;white-space:nowrap}
.cgc-cert.below{align-self:flex-start}
.cgc-title{font-size:19px;font-weight:700;white-space:nowrap}
.cgc-pub{font-size:16px;white-space:nowrap}
.qr-panel{background:#fff;border-radius:3px;padding:16px;display:flex;align-items:center;justify-content:center}

/* CGC-style card label (synthetic). */
.cgcc-label{height:136px;border:5px solid #14213d;display:flex;gap:10px;padding:12px 14px}
.cgcc-brand{color:#14213d;font-weight:700;font-size:28px;letter-spacing:1px;align-self:center}
.cgcc-mid{flex:1;display:flex;flex-direction:column;justify-content:space-between;font-weight:700;font-size:15px;
  min-width:0;white-space:nowrap}
.cgcc-mid .cert{font-size:20px;letter-spacing:1.5px}
.cgcc-right{display:flex;flex-direction:column;align-items:center;justify-content:center;width:88px;flex:none}
.cgcc-right .word{font-weight:700;font-size:16px;white-space:nowrap}
.cgcc-right .num{font-weight:700;font-size:44px;line-height:1}

/* Neutral labels. */
.plain-label{height:136px;border:4px solid #8d949b;display:flex;align-items:center;justify-content:center}
.plain-label .num{font-weight:700;font-size:26px;letter-spacing:2px}
.foreign-label{height:184px;border:4px solid #6c5aa8;display:flex;align-items:center;justify-content:space-between;
  padding:6px 6px 6px 18px}
.foreign-label .words{display:flex;flex-direction:column;gap:14px;width:230px}
.foreign-label .scan{font-weight:700;font-size:22px;letter-spacing:1px;color:#3d2f73}

/* Synthetic card front/back (no glyphs: grey bars stand in for printed text). */
.card{width:420px;height:586px;border-radius:14px;background:var(--frame);padding:16px;display:flex;flex-direction:column;
  gap:10px;box-shadow:0 1px 0 rgba(0,0,0,.25)}
.card-name{height:30px;display:flex;align-items:center;justify-content:space-between;padding:0 6px}
.card-art{position:relative;flex:0 0 300px;border-radius:6px;overflow:hidden;border:3px solid rgba(0,0,0,.22);
  background:radial-gradient(circle at 30% 35%,var(--art1),var(--art2) 72%)}
.blob{position:absolute;border-radius:50%}
.card-text{flex:1;background:var(--panel);border-radius:6px;padding:18px 16px;display:flex;flex-direction:column;gap:14px}
.card-back{width:420px;height:586px;border-radius:14px;background:#1f3f8f;border:14px solid #2d58b8;position:relative;
  overflow:hidden}
.ring{position:absolute;border-radius:50%;left:50%;top:50%;transform:translate(-50%,-50%)}

/* Synthetic comic cover (no glyphs). */
.comic{width:480px;height:732px;position:relative;overflow:hidden;background:var(--bg);border:2px solid rgba(0,0,0,.35)}
.masthead{position:absolute;left:0;right:0;top:0;height:110px;background:var(--mast);display:flex;flex-direction:column;
  justify-content:center;gap:12px;padding:0 24px}
.corner{position:absolute;left:16px;top:126px;width:86px;height:112px;background:#fff;border:3px solid #111}
.burst{position:absolute;border-radius:50%}
.panel-strip{position:absolute;left:24px;right:24px;bottom:24px;height:120px;background:rgba(255,255,255,.9);
  border:3px solid #111;display:flex;flex-direction:column;justify-content:center;gap:12px;padding:0 18px}
`;

const page = (body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${body}</body></html>`;

function cardFront({ frame, art1, art2, panel }) {
  return `<div class="card" style="--frame:${frame};--art1:${art1};--art2:${art2};--panel:${panel}">
  <div class="card-name"><span class="bar w60"></span><span class="bar w30"></span></div>
  <div class="card-art">
    <div class="blob" style="width:200px;height:200px;left:150px;top:46px;background:radial-gradient(circle at 40% 40%,rgba(255,255,255,.75),rgba(255,255,255,0) 70%)"></div>
    <div class="blob" style="width:120px;height:120px;left:40px;top:150px;background:rgba(0,0,0,.18)"></div>
    <div class="blob" style="width:70px;height:70px;left:300px;top:200px;background:rgba(255,255,255,.35)"></div>
  </div>
  <div class="card-text"><span class="bar w90"></span><span class="bar w80"></span><span class="bar w70"></span><span class="bar w50"></span></div>
</div>`;
}

function cardBack() {
  return `<div class="card-back">
  <div class="ring" style="width:340px;height:500px;border:10px solid #3b6fd6"></div>
  <div class="ring" style="width:240px;height:360px;border:10px solid #f2c94c"></div>
  <div class="ring" style="width:120px;height:120px;background:#fff;border:10px solid #c0392b"></div>
</div>`;
}

function comicCover() {
  return `<div class="comic" style="--bg:#f2c230;--mast:#c62828">
  <div class="masthead"><span class="bar light w80" style="height:26px;border-radius:6px"></span><span class="bar light w50"></span></div>
  <div class="corner"></div>
  <div class="burst" style="width:330px;height:330px;left:120px;top:190px;background:radial-gradient(circle,#ffffff 0%,#ffe08a 40%,rgba(255,224,138,0) 70%)"></div>
  <div class="burst" style="width:200px;height:260px;left:150px;top:260px;background:#1b1b1b;border-radius:45% 45% 30% 30%"></div>
  <div class="burst" style="width:150px;height:150px;left:-30px;top:420px;background:#2a5bd7"></div>
  <div class="burst" style="width:110px;height:110px;left:370px;top:330px;background:#e53935"></div>
  <div class="panel-strip"><span class="bar w90"></span><span class="bar w60"></span></div>
</div>`;
}

const shot = (inner) => `<div id="shot">${inner}</div>`;
const cardSlab = (label, content) => shot(`<div class="slab card-slab">${label}<div class="window">${content}</div></div>`);
const comicSlab = (label, content) => shot(`<div class="slab comic-slab">${label}<div class="window">${content}</div></div>`);

function psaFrontLabel({ lines, grade, cert }) {
  return `<div class="label psa-label">
  <div class="left">${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>
  <div class="right"><div class="grade">${esc(grade)}</div><div class="psa-brand">PSA</div><div class="cert">${esc(cert)}</div></div>
</div>`;
}

function psaBackLabel({ barcode, cert }) {
  return `<div class="label psa-back">
  <div class="top"><span class="psa-brand">PSA</span><span class="bar w30" style="background:rgba(0,0,0,.35)"></span></div>
  <div class="quiet"><img class="code" src="${dataUrl(barcode)}" alt=""></div>
  <div class="cert">${esc(cert)}</div>
</div>`;
}

function cgcComicLabel({ grade, title, pub, certText, qr }) {
  const certRow = qr
    ? `<div class="cgc-universal">UNIVERSAL GRADE</div>`
    : `<div class="row"><span class="cgc-universal">UNIVERSAL GRADE</span><span class="cgc-cert">${esc(certText)}</span></div>`;
  const certBelow = qr ? `<div class="cgc-cert below">${esc(certText)}</div>` : '';
  return `<div class="label cgc-label">
  <div class="cgc-left"><div class="cgc-brand">CGC</div><div class="cgc-gradebox"><div class="cgc-grade">${esc(grade)}</div></div><div class="cgc-pages">WHITE<br>PAGES</div></div>
  <div class="cgc-info">${certRow}<div class="cgc-title">${esc(title)}</div><div class="cgc-pub">${esc(pub)}</div>${certBelow}<span class="bar w60" style="margin-top:auto;background:rgba(0,0,0,.25)"></span></div>
  ${qr ? `<div class="qr-panel"><img class="code" src="${dataUrl(qr)}" alt=""></div>` : ''}
</div>`;
}

function cgcCardLabel({ lines, gradeWord, gradeNum, cert }) {
  return `<div class="label cgcc-label">
  <div class="cgcc-brand">CGC</div>
  <div class="cgcc-mid">${lines.map((l) => `<div>${esc(l)}</div>`).join('')}<div class="cert">${esc(cert)}</div></div>
  <div class="cgcc-right"><div class="word">${esc(gradeWord)}</div><div class="num">${esc(gradeNum)}</div></div>
</div>`;
}

const plainLabel = (num) => `<div class="label plain-label"><div class="num">${esc(num)}</div></div>`;

const foreignQrLabel = (qr) => `<div class="label foreign-label">
  <div class="words"><div class="scan">SCAN TO VERIFY</div><span class="bar w90"></span><span class="bar w70"></span><span class="bar w50"></span></div>
  <div class="qr-panel"><img class="code" src="${dataUrl(qr)}" alt=""></div>
</div>`;

const NON_SLAB_HTML = page(`<div id="shot" style="padding:0">
<div style="position:relative;width:640px;height:420px;overflow:hidden;background:linear-gradient(180deg,#7fb3e6 0%,#bcd9f2 55%,#f3e2c4 100%)">
  <div style="position:absolute;left:430px;top:60px;width:120px;height:120px;border-radius:50%;background:radial-gradient(circle,#fff6d8 0%,#ffd76a 45%,rgba(255,215,106,0) 72%)"></div>
  <div style="position:absolute;left:-120px;top:250px;width:560px;height:320px;border-radius:50%;background:linear-gradient(180deg,#6aa84f,#38761d)"></div>
  <div style="position:absolute;left:260px;top:280px;width:560px;height:300px;border-radius:50%;background:linear-gradient(180deg,#93c47d,#4e8a35)"></div>
  <div style="position:absolute;left:120px;top:170px;width:90px;height:120px;border-radius:50%;background:#2f5d2a;filter:blur(2px)"></div>
  <div style="position:absolute;left:158px;top:280px;width:14px;height:40px;background:#5b3b1f"></div>
  <div style="position:absolute;left:60px;top:40px;width:180px;height:44px;border-radius:22px;background:rgba(255,255,255,.8);filter:blur(3px)"></div>
</div></div>`);

// ---------------------------------------------------------------------------------------------
// Fixture specifications (single source of truth for files, manifest and gallery)
// ---------------------------------------------------------------------------------------------
function fixtureSpecs(codes) {
  const psa1 = { lines: ['2023 POKEMON SV 151', 'CHARIZARD ex', '#199'], grade: 'GEM MT 10', cert: '01234567' };
  const psa2 = { lines: ['1986 FLEER', 'MICHAEL JORDAN', '#57'], grade: 'MINT 9', cert: '108114622' };
  const comic = { grade: '9.8', title: 'Amazing Spider-Man #300', pub: 'Marvel Comics, 5/88' };
  const card = { lines: ['2022 Pokemon Sword & Shield', 'Pikachu - Holo'], gradeWord: 'GEM MINT', gradeNum: '10', cert: '1401036622258' };

  return [
    {
      file: 'psa-8digit-leading-zero.png',
      html: page(cardSlab(psaFrontLabel(psa1), cardFront({ frame: '#e9c74b', art1: '#ff9a4a', art2: '#b3261e', panel: '#f6e7b0' }))),
      description: 'PSA-style front label, 8-digit cert with leading zero, grade "GEM MT 10", plain-text "PSA" brand. Crisp natural-size render.',
      expected: { status: 'auto-open', grader: 'psa', number: '01234567' },
      tags: ['ocr', 'psa', 'front-label', 'leading-zero'],
      labelText: [...psa1.lines, psa1.grade, 'PSA', psa1.cert],
      barcode: null,
    },
    {
      file: 'psa-9digit.png',
      html: page(cardSlab(psaFrontLabel(psa2), cardFront({ frame: '#f7f7f2', art1: '#4f7fe0', art2: '#0f2a66', panel: '#d7263d' }))),
      description: 'PSA-style front label, 9-digit cert, grade "MINT 9", plain-text "PSA" brand.',
      expected: { status: 'auto-open', grader: 'psa', number: '108114622' },
      tags: ['ocr', 'psa', 'front-label'],
      labelText: [...psa2.lines, psa2.grade, 'PSA', psa2.cert],
      barcode: null,
    },
    {
      file: 'psa-back-barcode.png',
      html: page(cardSlab(psaBackLabel({ barcode: codes.code128, cert: PSA_BACK_CERT }), cardBack())),
      description: 'PSA-style back label: crisp Code128 (3 px modules, >=12-module quiet zone each side) encoding 81234567 with the number printed underneath; card back below.',
      expected: { status: 'auto-open', grader: 'psa', number: PSA_BACK_CERT },
      accept: ['auto-open', 'confirm'],
      notes: 'Number must match exactly (barcode path). An 8-digit barcode-only number may legitimately ask for confirmation if the keyword pass misses the plain-text "PSA" brand; auto-open is preferred.',
      tags: ['barcode', 'code128', 'ocr', 'psa', 'back-label'],
      labelText: ['PSA', PSA_BACK_CERT],
      barcode: { format: 'Code128', text: PSA_BACK_CERT, modulePx: 3, quietZonePx: 36 },
    },
    {
      file: 'cgc-comic-10digit.png',
      html: page(comicSlab(cgcComicLabel({ ...comic, certText: '4012345001' }), comicCover())),
      description: 'CGC-style comic label (blue band): "CGC", "UNIVERSAL GRADE", "9.8", "WHITE PAGES", title "Amazing Spider-Man #300", "Marvel Comics, 5/88", 10-digit cert.',
      expected: { status: 'auto-open', grader: 'cgc-comics', number: '4012345001' },
      tags: ['ocr', 'cgc', 'comic'],
      labelText: ['CGC', '9.8', 'WHITE PAGES', 'UNIVERSAL GRADE', '4012345001', comic.title, comic.pub],
      barcode: null,
    },
    {
      file: 'cgc-comic-dash.png',
      html: page(comicSlab(cgcComicLabel({ ...comic, certText: '4012346-002' }), comicCover())),
      description: 'Same CGC comic layout; cert printed with a separator as "4012346-002" (expected normalised to 4012346002).',
      expected: { status: 'auto-open', grader: 'cgc-comics', number: '4012346002' },
      tags: ['ocr', 'cgc', 'comic', 'separator'],
      labelText: ['CGC', '9.8', 'WHITE PAGES', 'UNIVERSAL GRADE', '4012346-002', comic.title, comic.pub],
      barcode: null,
    },
    {
      file: 'cgc-comic-qr.png',
      html: page(comicSlab(cgcComicLabel({ ...comic, certText: '4012347003', qr: codes.cgcQr }), comicCover())),
      description: `CGC comic label with a QR (4 px modules, version 4, ECC M, 4-module quiet zone) encoding ${CGC_QR_URL}; number also printed.`,
      expected: { status: 'auto-open', grader: 'cgc-comics', number: '4012347003' },
      tags: ['qr', 'ocr', 'cgc', 'comic'],
      labelText: ['CGC', '9.8', 'WHITE PAGES', 'UNIVERSAL GRADE', '4012347003', comic.title, comic.pub],
      barcode: { format: 'QRCode', text: CGC_QR_URL, modulePx: 4, quietZonePx: 16 },
    },
    {
      file: 'cgc-card-13digit.png',
      html: page(cardSlab(cgcCardLabel(card), cardFront({ frame: '#f1d34a', art1: '#fff07a', art2: '#e0a106', panel: '#f7efc8' }))),
      description: 'CGC-style card label: "CGC", "GEM MINT 10", "2022 Pokemon Sword & Shield / Pikachu - Holo", 13-digit cert starting 1401.',
      expected: { status: 'auto-open', grader: 'cgc-cards', number: '1401036622258' },
      tags: ['ocr', 'cgc', 'card', '13-digit'],
      labelText: ['CGC', ...card.lines, card.gradeWord, card.gradeNum, card.cert],
      barcode: null,
    },
    {
      file: 'qr-foreign-host.png',
      html: page(cardSlab(foreignQrLabel(codes.foreignQr), cardFront({ frame: '#8e7cc3', art1: '#d5a6ff', art2: '#4b2a8a', panel: '#e6dcf7' }))),
      description: `Label-like slab whose only number is inside a QR encoding ${FOREIGN_QR_URL} (host not on the grader allow-list); no printed number, no grader words.`,
      expected: { status: 'confirm', grader: null, number: null },
      accept: ['confirm', 'none'],
      mustNotAutoOpen: true,
      mustNotOpen: [FOREIGN_QR_URL],
      mustNotOpenHosts: ['evil.example'],
      notes: 'Security negative (orchestrator decision 2026-10-09): confirm or none are both acceptable. In confirm the QR digits may appear only as a capped candidate (confidence <= 0.50) with the qr-untrusted-host warning, so the user decides. Hard checks: never auto-open; the decoded URL/host is never navigated or requested; any page opened from confirm uses a URL rebuilt from grader + digits.',
      expectWarning: 'qr-untrusted-host',
      tags: ['qr', 'negative', 'security', 'foreign-host'],
      labelText: ['SCAN TO VERIFY'],
      barcode: { format: 'QRCode', text: FOREIGN_QR_URL, modulePx: 4, quietZonePx: 16 },
    },
    {
      file: 'ambiguous-10digit.png',
      html: page(cardSlab(plainLabel('5012345678'), cardFront({ frame: '#9fb8ad', art1: '#d9ead3', art2: '#5f8575', panel: '#e3ece7' }))),
      description: 'Plain white label containing only the 10-digit number 5012345678; no grader words, so the grader cannot be decided.',
      expected: { status: 'confirm', grader: null, number: '5012345678' },
      graderUnresolved: true,
      mustNotAutoOpen: true,
      notes: 'Must not auto-open. Show 5012345678 as the candidate with a grader selector.',
      tags: ['ocr', 'ambiguous'],
      labelText: ['5012345678'],
      barcode: null,
    },
    {
      file: 'non-slab.png',
      html: NON_SLAB_HTML,
      description: 'Photo-like landscape gradient (sky, sun, hills) with no digits or text.',
      expected: { status: 'none', grader: null, number: null },
      mustNotAutoOpen: true,
      tags: ['negative'],
      labelText: [],
      barcode: null,
    },
    {
      file: 'psa-lowres.jpg',
      from: 'psa-8digit-leading-zero.png',
      transform: { type: 'downscale', width: 260, format: 'image/jpeg', quality: 0.7 },
      description: 'psa-8digit-leading-zero.png downscaled to 260 px wide (high-quality resample) and saved as JPEG quality 0.7, like a marketplace thumbnail.',
      expected: { status: 'confirm', grader: 'psa', number: '01234567' },
      accept: ['auto-open', 'confirm'],
      notes: 'Either auto-open or confirm is acceptable; the shown number must be 01234567 (leading zero kept) and the grader PSA.',
      tags: ['ocr', 'psa', 'lowres', 'jpeg', 'leading-zero', 'derived'],
      labelText: [...psa1.lines, psa1.grade, 'PSA', psa1.cert],
      barcode: null,
    },
    {
      file: 'cgc-comic-rotated.png',
      from: 'cgc-comic-10digit.png',
      transform: { type: 'rotate', degrees: 4, background: BACKDROP, margin: 8, format: 'image/png' },
      description: 'cgc-comic-10digit.png rotated 4 degrees clockwise on a neutral background.',
      expected: { status: 'auto-open', grader: 'cgc-comics', number: '4012345001' },
      accept: ['auto-open', 'confirm'],
      notes: 'Skew robustness. Number and grader must match; confirm is tolerated if confidence drops.',
      tags: ['ocr', 'cgc', 'comic', 'rotated', 'derived'],
      labelText: ['CGC', '9.8', 'WHITE PAGES', 'UNIVERSAL GRADE', '4012345001', comic.title, comic.pub],
      barcode: null,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// OCR benchmark set (tests/fixtures/bench/, ADR-001 §14 D3 gate)
// Clean renders vary grader, cert length and leading zeros; derived files apply one or more
// deterministic degradations. Card/comic art is abstract; "busy" variants add printed digits
// (set numbers, years, HP, copyright ranges, a seller lot sticker) that compete with the cert.
// ---------------------------------------------------------------------------------------------
const BENCH_CSS = `
.card-name .nm{font-weight:700;font-size:18px;color:#1d1d1d;white-space:nowrap}
.art-text{position:absolute;font-weight:700;white-space:nowrap;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.7)}
.card-text .txt{font-size:15px;font-weight:700;color:#1d1d1d;white-space:nowrap;display:flex;justify-content:space-between;gap:12px}
.card-text .txt.small{font-size:11px;font-weight:400}
.cover-text{position:absolute;font-weight:700;white-space:nowrap;line-height:1}
.cgc-label.ss{background:#e2b007;color:#111}
.cgc-label.ss .cgc-universal{color:#6b4e00}
.sticker{position:absolute;background:#fffbe6;border:2px solid #b08900;border-radius:4px;padding:4px 8px;font-weight:700;
  font-size:16px;color:#222;letter-spacing:1px;white-space:nowrap}
`;
const benchPage = (body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${BASE_CSS}${BENCH_CSS}</style></head><body>${body}</body></html>`;

const BENCH_QR_URL = 'https://www.cgccomics.com/certlookup/4155667002/';
const BENCH_BARCODE_CERT = '61834502';

async function makeBenchBarcodes() {
  const code128 = await bwipjs.toBuffer({ bcid: 'code128', text: BENCH_BARCODE_CERT, scale: 3, height: 12, includetext: false });
  const qr = await bwipjs.toBuffer({ bcid: 'qrcode', text: BENCH_QR_URL, scale: 2, eclevel: 'M' });
  return { code128, qr };
}

/** Card front with printed text instead of grey bars (busy art). */
function busyCardFront({ frame, art1, art2, panel, name, hp, artText = [], lines = [], sticker = null }) {
  const art = artText.map((a) => `<div class="art-text" style="left:${a.x}px;top:${a.y}px;font-size:${a.size}px${a.color ? `;color:${a.color}` : ''}">${esc(a.text)}</div>`).join('');
  const txt = lines.map(([l, r, small]) => `<div class="txt${small ? ' small' : ''}"><span>${esc(l)}</span><span>${esc(r ?? '')}</span></div>`).join('');
  return `<div class="card" style="--frame:${frame};--art1:${art1};--art2:${art2};--panel:${panel}">
  <div class="card-name"><span class="nm">${esc(name)}</span><span class="nm">${esc(hp)}</span></div>
  <div class="card-art">
    <div class="blob" style="width:200px;height:200px;left:150px;top:46px;background:radial-gradient(circle at 40% 40%,rgba(255,255,255,.75),rgba(255,255,255,0) 70%)"></div>
    <div class="blob" style="width:120px;height:120px;left:40px;top:150px;background:rgba(0,0,0,.18)"></div>
    ${art}
    ${sticker ? `<div class="sticker" style="left:${sticker.x}px;top:${sticker.y}px">${esc(sticker.text)}</div>` : ''}
  </div>
  <div class="card-text">${txt}</div>
</div>`;
}

/** Card front identical to cardFront() plus an optional seller sticker on the art. */
function stickerCardFront({ frame, art1, art2, panel, sticker }) {
  return cardFront({ frame, art1, art2, panel }).replace('<div class="card-text">',
    `<div class="sticker" style="position:relative;align-self:flex-start;margin:-52px 0 0 180px">${esc(sticker)}</div><div class="card-text">`);
}

/** Comic cover with printed masthead, issue number, price and date (busy art). */
function busyComicCover({ title, issue, price, month, year, blurb }) {
  return `<div class="comic" style="--bg:#f2c230;--mast:#c62828">
  <div class="masthead"></div>
  <div class="cover-text" style="left:24px;top:30px;font-size:46px;color:#fff;letter-spacing:2px">${esc(title)}</div>
  <div class="corner"></div>
  <div class="cover-text" style="left:28px;top:138px;font-size:26px;color:#111">${esc(price)}</div>
  <div class="cover-text" style="left:28px;top:172px;font-size:16px;color:#111">${esc(month)}</div>
  <div class="cover-text" style="left:28px;top:196px;font-size:22px;color:#111">${esc(year)}</div>
  <div class="cover-text" style="left:330px;top:128px;font-size:28px;color:#111">${esc(issue)}</div>
  <div class="burst" style="width:330px;height:330px;left:120px;top:190px;background:radial-gradient(circle,#ffffff 0%,#ffe08a 40%,rgba(255,224,138,0) 70%)"></div>
  <div class="burst" style="width:200px;height:260px;left:150px;top:260px;background:#1b1b1b;border-radius:45% 45% 30% 30%"></div>
  <div class="burst" style="width:150px;height:150px;left:-30px;top:420px;background:#2a5bd7"></div>
  <div class="panel-strip"><div class="cover-text" style="position:static;font-size:24px;color:#111">${esc(blurb)}</div></div>
</div>`;
}

/** cgcComicLabel() with a selectable grade band (universal / signature series) and page-quality lines. */
function cgcComicLabelV({ grade, title, pub, certText, qr = null, band = 'universal', pages = ['WHITE', 'PAGES'] }) {
  const word = band === 'signature' ? 'SIGNATURE SERIES' : 'UNIVERSAL GRADE';
  const certRow = qr
    ? `<div class="cgc-universal">${word}</div>`
    : `<div class="row"><span class="cgc-universal">${word}</span><span class="cgc-cert">${esc(certText)}</span></div>`;
  const certBelow = qr ? `<div class="cgc-cert below">${esc(certText)}</div>` : '';
  return `<div class="label cgc-label${band === 'signature' ? ' ss' : ''}">
  <div class="cgc-left"><div class="cgc-brand">CGC</div><div class="cgc-gradebox"><div class="cgc-grade">${esc(grade)}</div></div><div class="cgc-pages">${pages.map(esc).join('<br>')}</div></div>
  <div class="cgc-info">${certRow}<div class="cgc-title">${esc(title)}</div><div class="cgc-pub">${esc(pub)}</div>${certBelow}<span class="bar w60" style="margin-top:auto;background:rgba(0,0,0,.25)"></span></div>
  ${qr ? `<div class="qr-panel"><img class="code" src="${dataUrl(qr)}" alt=""></div>` : ''}
</div>`;
}

const ART = {
  gold: { frame: '#e9c74b', art1: '#ff9a4a', art2: '#b3261e', panel: '#f6e7b0' },
  white: { frame: '#f7f7f2', art1: '#4f7fe0', art2: '#0f2a66', panel: '#d7263d' },
  green: { frame: '#9fd18b', art1: '#d9f2c4', art2: '#2e7d32', panel: '#eef7e6' },
  blue: { frame: '#8fb3e8', art1: '#cfe3ff', art2: '#1e4f9c', panel: '#e3edfb' },
  yellow: { frame: '#f1d34a', art1: '#fff07a', art2: '#e0a106', panel: '#f7efc8' },
  red: { frame: '#e57373', art1: '#ffd0c4', art2: '#a62020', panel: '#fbe3df' },
  purple: { frame: '#b39ddb', art1: '#efe2ff', art2: '#5e35b1', panel: '#ede7f6' },
};

const AUTO_OR_CONFIRM = ['auto-open', 'confirm'];

function benchSpecs(codes) {
  const psa = (id, { lines, grade, cert, art, desc }) => ({
    id, file: `${id}.png`, html: benchPage(cardSlab(psaFrontLabel({ lines, grade, cert }), cardFront(ART[art]))),
    category: 'clean', degradations: [], description: `PSA-style front label, ${cert.length}-digit cert ${cert}${/^0/.test(cert) ? ' (leading zero)' : ''}, grade "${grade}". ${desc ?? ''}`.trim(),
    expected: { status: 'auto-open', grader: 'psa', number: cert }, accept: AUTO_OR_CONFIRM,
    tags: ['psa', `len:${cert.length}`, ...(/^0/.test(cert) ? ['leading-zero'] : [])], labelText: [...lines, grade, 'PSA', cert], barcode: null,
  });
  const comic = (id, { grade, title, pub, cert, certText = cert, band, pages, qr = null, desc }) => ({
    id, file: `${id}.png`, html: benchPage(comicSlab(cgcComicLabelV({ grade, title, pub, certText, qr, band, pages }), comicCover())),
    category: 'clean', degradations: [], description: `CGC-style comic label (${band === 'signature' ? 'signature series band' : 'universal band'}), cert printed "${certText}", grade ${grade}. ${desc ?? ''}`.trim(),
    expected: { status: 'auto-open', grader: 'cgc-comics', number: cert }, accept: AUTO_OR_CONFIRM,
    tags: ['cgc', 'comic', `len:${cert.length}`, ...(certText !== cert ? ['separator'] : []), ...(qr ? ['qr'] : [])],
    labelText: ['CGC', grade, (pages ?? ['WHITE', 'PAGES']).join(' '), band === 'signature' ? 'SIGNATURE SERIES' : 'UNIVERSAL GRADE', certText, title, pub],
    barcode: qr ? { format: 'QRCode', text: BENCH_QR_URL, modulePx: 4, quietZonePx: 16 } : null,
  });
  const card = (id, { lines, gradeWord, gradeNum, cert, art, desc }) => ({
    id, file: `${id}.png`, html: benchPage(cardSlab(cgcCardLabel({ lines, gradeWord, gradeNum, cert }), cardFront(ART[art]))),
    category: 'clean', degradations: [], description: `CGC-style card label, ${cert.length}-digit cert ${cert}, "${gradeWord} ${gradeNum}". ${desc ?? ''}`.trim(),
    expected: { status: 'auto-open', grader: 'cgc-cards', number: cert }, accept: AUTO_OR_CONFIRM,
    tags: ['cgc', 'card', `len:${cert.length}`, ...(cert.length === 10 ? ['card-wording-10'] : [])],
    labelText: ['CGC', ...lines, gradeWord, gradeNum, cert], barcode: null,
  });

  const clean = [
    psa('psa-c01', { lines: ['2021 CHROME SERIES', 'ROOKIE SLUGGER', '#27'], grade: 'GEM MT 10', cert: '04718263', art: 'gold' }),
    psa('psa-c02', { lines: ['1999 BASE SET', 'WATER TURTLE-HOLO', '#2'], grade: 'NM-MT 8', cert: '72910483', art: 'blue' }),
    psa('psa-c03', { lines: ['2018 PRIZM', 'POINT GUARD', '#280'], grade: 'MINT 9', cert: '109876543', art: 'white' }),
    psa('psa-c04', { lines: ['1993 FINEST', 'REFRACTOR', '#88'], grade: 'GEM MT 10', cert: '00573921', art: 'green' }),
    psa('psa-c05', { lines: ['2000 NEO GENESIS', 'LIGHTNING MOUSE', '#70'], grade: 'NM-MT 8', cert: '056734128', art: 'yellow' }),
    psa('psa-c06', { lines: ['1989 UPPER TIER', 'STAR ROOKIE', '#1'], grade: 'EX-MT 6', cert: '30561247', art: 'red' }),
    psa('psa-c07', { lines: ['1986 BASKETBALL', 'HIGH FLYER', '#57'], grade: 'VG-EX 4', cert: '5123478', art: 'purple', desc: 'Older 7-digit format.' }),
    {
      id: 'psa-c08', file: 'psa-c08.png',
      html: benchPage(cardSlab(psaBackLabel({ barcode: codes.code128, cert: BENCH_BARCODE_CERT }), cardBack())),
      category: 'clean', degradations: [],
      description: `PSA-style back label: Code128 (3 px modules) encoding ${BENCH_BARCODE_CERT}, number printed underneath.`,
      expected: { status: 'auto-open', grader: 'psa', number: BENCH_BARCODE_CERT }, accept: AUTO_OR_CONFIRM,
      tags: ['psa', 'barcode', 'code128', 'len:8'], labelText: ['PSA', BENCH_BARCODE_CERT],
      barcode: { format: 'Code128', text: BENCH_BARCODE_CERT, modulePx: 3, quietZonePx: 36 },
    },
    comic('cgcc-c09', { grade: '9.8', title: 'Cosmic Tales #1', pub: 'Atlas Press, 3/63', cert: '3984561002' }),
    comic('cgcc-c10', { grade: '9.6', title: 'Night Avenger #423', pub: 'Gotham Ink, 9/88', cert: '4087123006', pages: ['OFF-WHITE', 'PAGES'] }),
    comic('cgcc-c11', { grade: '9.4', title: 'Star Rangers #12', pub: 'Nova Comics, 6/77', cert: '4102938015', certText: '4102938-015' }),
    comic('cgcc-c12', { grade: '9.8', title: 'Mutant Squad #1', pub: 'Apex Comics, 8/91', cert: '3765432011', band: 'signature', desc: 'Yellow band, dark text.' }),
    comic('cgcc-c13', { grade: '9.2', title: 'Deep Sea Saga #5', pub: 'Tidal Press, 2/71', cert: '4155667002', qr: codes.qr, desc: `QR encodes ${BENCH_QR_URL}.` }),
    card('cgcd-c14', { lines: ['2022 Sword Set', 'Electric Mouse - Holo'], gradeWord: 'GEM MINT', gradeNum: '10', cert: '1402345678901', art: 'yellow' }),
    card('cgcd-c15', { lines: ['2023 Scarlet Set', 'Fire Lizard ex'], gradeWord: 'PRISTINE', gradeNum: '10', cert: '1403987650123', art: 'red' }),
    card('cgcd-c16', { lines: ['2021 Celebrations', 'Sea Dragon - Holo'], gradeWord: 'GEM MINT', gradeNum: '10', cert: '3901234567', art: 'blue', desc: '10-digit cert with card wording.' }),
    card('cgcd-c17', { lines: ['1999 Base Set', 'Water Turtle - Holo'], gradeWord: 'NM/MINT+', gradeNum: '8.5', cert: '2938475610', art: 'green', desc: '10-digit cert with card wording.' }),
    card('cgcd-c18', { lines: ['2020 Vivid Set', 'Thunder Bird V'], gradeWord: 'MINT+', gradeNum: '9.5', cert: '1405551234567', art: 'purple' }),
    {
      id: 'neg-c19', file: 'neg-c19.png', html: benchPage(cardSlab(plainLabel('6012349870'), cardFront(ART.green))),
      category: 'negative', degradations: [],
      description: 'Plain label with only the 10-digit number 6012349870 and no grader words: grader cannot be decided.',
      expected: { status: 'confirm', grader: null, number: '6012349870' }, accept: ['confirm'], graderUnresolved: true, mustNotAutoOpen: true,
      tags: ['ambiguous', 'len:10'], labelText: ['6012349870'], barcode: null,
    },
    {
      id: 'neg-c20', file: 'neg-c20.png',
      html: benchPage(shot(busyCardFront({
        ...ART.blue, name: 'SEA DRAGON', hp: 'HP 120',
        artText: [{ text: '2023', x: 18, y: 12, size: 30 }, { text: '#199', x: 290, y: 252, size: 24 }],
        lines: [['Tidal Wave', '120'], ['Weakness x2', 'Retreat 3'], ['Illus. Studio 7', '012/165', true], ['©1995-2023 Fictional Games', '', true]],
      }))),
      category: 'negative', degradations: [],
      description: 'Raw (ungraded) card photo, no slab or label; printed digits: 2023, #199, HP 120, 012/165, ©1995-2023.',
      expected: { status: 'none', grader: null, number: null }, accept: ['none', 'confirm'], mustNotAutoOpen: true,
      tags: ['negative', 'no-slab', 'busy-art'], labelText: [], barcode: null,
    },
  ];
  const byId = Object.fromEntries(clean.map((s) => [s.id, s]));

  const busy = [
    {
      id: 'psa-b01', file: 'psa-b01.png',
      html: benchPage(cardSlab(psaFrontLabel({ lines: ['2023 SV 151', 'FIRE LIZARD ex', '#199'], grade: 'GEM MT 10', cert: '07294618' }),
        busyCardFront({
          ...ART.gold, name: 'FIRE LIZARD ex', hp: 'HP 330',
          artText: [{ text: '151', x: 18, y: 12, size: 32 }, { text: '#199', x: 290, y: 252, size: 24 }],
          lines: [['Fire Spin', '180'], ['Weakness x2', 'Retreat 3'], ['Illus. Studio 1999', '199/165', true], ['©1995-2023 Fictional Games', '', true]],
        }))),
      description: 'PSA-style label (8-digit cert 07294618, leading zero) over busy card art with printed digits: 151, #199, HP 330, 180, 199/165, ©1995-2023.',
      expected: { status: 'auto-open', grader: 'psa', number: '07294618' }, labelText: ['2023 SV 151', 'FIRE LIZARD ex', '#199', 'GEM MT 10', 'PSA', '07294618'],
      tags: ['psa', 'len:8', 'leading-zero'], barcode: null,
    },
    {
      id: 'cgcc-b02', file: 'cgcc-b02.png',
      html: benchPage(comicSlab(cgcComicLabelV({ grade: '9.8', title: 'Cosmic Tales #300', pub: 'Atlas Press, 5/88', certText: '4011223004' }),
        busyComicCover({ title: 'COSMIC TALES', issue: 'No. 300', price: '75¢', month: 'MAY', year: '1988', blurb: 'THE 1988 SAGA BEGINS!' }))),
      description: 'CGC-style comic label (cert 4011223004) over a cover with printed title, "No. 300", "75¢", "MAY 1988" and a blurb with a year.',
      expected: { status: 'auto-open', grader: 'cgc-comics', number: '4011223004' }, labelText: ['CGC', '9.8', 'WHITE PAGES', 'UNIVERSAL GRADE', '4011223004', 'Cosmic Tales #300', 'Atlas Press, 5/88'],
      tags: ['cgc', 'comic', 'len:10'], barcode: null,
    },
    {
      id: 'cgcd-b03', file: 'cgcd-b03.png',
      html: benchPage(cardSlab(cgcCardLabel({ lines: ['1999 Base Set', 'Electric Mouse #58'], gradeWord: 'GEM MINT', gradeNum: '10', cert: '1404440987654' }),
        busyCardFront({
          ...ART.yellow, name: 'ELECTRIC MOUSE', hp: 'HP 60',
          artText: [{ text: '1999', x: 18, y: 12, size: 28 }, { text: '58/102', x: 270, y: 254, size: 24 }],
          lines: [['Thunder Jolt', '30'], ['Weakness x2', 'Retreat 1'], ['©1995-1999 Fictional Games', '58/102', true]],
        }))),
      description: 'CGC-style card label (13-digit cert 1404440987654) over busy card art with printed digits: 1999, 58/102, HP 60, ©1995-1999.',
      expected: { status: 'auto-open', grader: 'cgc-cards', number: '1404440987654' }, labelText: ['CGC', '1999 Base Set', 'Electric Mouse #58', 'GEM MINT', '10', '1404440987654'],
      tags: ['cgc', 'card', 'len:13'], barcode: null,
    },
    {
      id: 'psa-b04', file: 'psa-b04.png',
      html: benchPage(cardSlab(psaFrontLabel({ lines: ['2020 BASE SERIES', 'STAR ROOKIE', '#5'], grade: 'GEM MT 10', cert: '81726354' }),
        stickerCardFront({ ...ART.white, sticker: 'LOT 20230417' }))),
      description: 'PSA-style label (cert 81726354) plus a seller inventory sticker "LOT 20230417" on the card: a second 8-digit, PSA-length number competes.',
      expected: { status: 'confirm', grader: 'psa', number: '81726354' }, labelText: ['2020 BASE SERIES', 'STAR ROOKIE', '#5', 'GEM MT 10', 'PSA', '81726354', 'LOT 20230417'],
      tags: ['psa', 'len:8', 'competitor'], barcode: null,
      notes: 'Two valid PSA-length numbers: auto-open is allowed only if the sticker number was not read as a competitor (>= 0.50); the lot number must never be auto-opened.',
    },
  ].map((s) => ({ category: 'degraded', degradations: ['busy-art'], accept: AUTO_OR_CONFIRM, ...s, tags: [...s.tags, 'busy-art'] }));
  for (const s of busy) byId[s.id] = s;

  const JPEG40 = { format: 'image/jpeg', quality: 0.4 };
  const JPEG88 = { format: 'image/jpeg', quality: 0.88 };
  const PNG = { format: 'image/png' };
  const GLARE_CARD = { op: 'glare', cx: 0.3, cy: 0.12, r: 0.42, alpha: 0.78 };
  const GLARE_COMIC = { op: 'glare', cx: 0.22, cy: 0.13, r: 0.38, alpha: 0.78 };
  const DARK = [{ op: 'tone', brightness: 0.5, contrast: 0.55 }, { op: 'noise', amount: 10, seed: 0 }];
  const rot = (deg) => ({ op: 'rotate', degrees: deg, background: BACKDROP, margin: 8 });
  const TEXT = {
    'jpeg-q40': 'JPEG quality 0.40', 'scale-0.5': '0.5x downscale (high-quality resample)', 'blur-1px': 'Gaussian blur 1 px',
    'blur-2px': 'Gaussian blur 2 px', glare: 'white radial glare over the left part of the label', 'dark-low-contrast': 'brightness 0.5, contrast 0.55 and seeded noise',
  };
  const derive = (baseId, suffix, degradations, ops, encode, extra = {}) => {
    const base = byId[baseId];
    const ext = encode.format === 'image/jpeg' ? 'jpg' : 'png';
    const parts = degradations.map((d) => TEXT[d] ?? (d.startsWith('rotate') ? `rotated ${d.slice(7)} degrees` : d));
    return {
      id: `${baseId}-${suffix}`, file: `${baseId}-${suffix}.${ext}`, from: baseId, ops, encode,
      category: base.category === 'negative' ? 'negative' : 'degraded',
      degradations: [...base.degradations, ...degradations],
      description: `${baseId} (${base.description.split('.')[0]}) with ${parts.join(' + ')}${encode.format === 'image/jpeg' && !degradations.includes('jpeg-q40') ? `, saved as JPEG q${Math.round(encode.quality * 100)}` : ''}.`,
      expected: base.expected, accept: base.accept,
      ...(base.graderUnresolved ? { graderUnresolved: true } : {}), ...(base.mustNotAutoOpen ? { mustNotAutoOpen: true } : {}),
      tags: [...base.tags, 'derived', ...degradations], labelText: base.labelText, barcode: base.barcode,
      ...extra,
    };
  };

  const degraded = [
    derive('psa-c01', 'jpeg40', ['jpeg-q40'], [], JPEG40),
    derive('psa-c03', 'jpeg40', ['jpeg-q40'], [], JPEG40),
    derive('cgcc-c09', 'jpeg40', ['jpeg-q40'], [], JPEG40),
    derive('cgcd-c14', 'jpeg40', ['jpeg-q40'], [], JPEG40),
    derive('cgcd-c16', 'jpeg40', ['jpeg-q40'], [], JPEG40),
    derive('psa-c08', 'jpeg40', ['jpeg-q40'], [], JPEG40, { notes: 'Barcode may or may not survive JPEG; the printed number is also readable.' }),
    derive('cgcc-c13', 'jpeg40', ['jpeg-q40'], [], JPEG40),
    derive('psa-c02', 'half', ['scale-0.5'], [{ op: 'scale', factor: 0.5 }], PNG),
    derive('psa-c04', 'half', ['scale-0.5'], [{ op: 'scale', factor: 0.5 }], PNG),
    derive('cgcc-c10', 'half', ['scale-0.5'], [{ op: 'scale', factor: 0.5 }], PNG),
    derive('cgcd-c15', 'half', ['scale-0.5'], [{ op: 'scale', factor: 0.5 }], PNG),
    derive('psa-c08', 'half', ['scale-0.5'], [{ op: 'scale', factor: 0.5 }], PNG, { notes: '1.5 px barcode modules: barcode decode may fail; OCR of the printed number is the fallback.' }),
    derive('psa-c01', 'blur1', ['blur-1px'], [{ op: 'blur', px: 1 }], JPEG88),
    derive('cgcc-c11', 'blur1', ['blur-1px'], [{ op: 'blur', px: 1 }], JPEG88),
    derive('cgcd-c14', 'blur1', ['blur-1px'], [{ op: 'blur', px: 1 }], JPEG88),
    derive('psa-c03', 'blur2', ['blur-2px'], [{ op: 'blur', px: 2 }], JPEG88),
    derive('cgcc-c09', 'blur2', ['blur-2px'], [{ op: 'blur', px: 2 }], JPEG88),
    derive('cgcd-c17', 'blur2', ['blur-2px'], [{ op: 'blur', px: 2 }], JPEG88),
    derive('psa-c02', 'glare', ['glare'], [GLARE_CARD], JPEG88),
    derive('psa-c06', 'glare', ['glare'], [GLARE_CARD], JPEG88),
    derive('cgcc-c10', 'glare', ['glare'], [GLARE_COMIC], JPEG88),
    derive('cgcd-c14', 'glare', ['glare'], [GLARE_CARD], JPEG88),
    derive('psa-c03', 'rot-3', ['rotate:-3'], [rot(-3)], JPEG88),
    derive('cgcc-c09', 'rot5', ['rotate:5'], [rot(5)], JPEG88),
    derive('cgcd-c16', 'rot-6', ['rotate:-6'], [rot(-6)], JPEG88),
    derive('psa-c07', 'rot2', ['rotate:2'], [rot(2)], JPEG88),
    derive('psa-c04', 'dark', ['dark-low-contrast'], DARK, JPEG88),
    derive('cgcc-c12', 'dark', ['dark-low-contrast'], DARK, JPEG88),
    derive('cgcd-c18', 'dark', ['dark-low-contrast'], DARK, JPEG88),
    derive('psa-c05', 'dark', ['dark-low-contrast'], DARK, JPEG88),
    derive('psa-b01', 'jpeg40', ['jpeg-q40'], [], JPEG40),
    derive('cgcd-c14', 'rot-4-jpeg60', ['rotate:-4', 'jpeg-q60'], [rot(-4)], { format: 'image/jpeg', quality: 0.6 }),
    derive('neg-c20', 'jpeg40', ['jpeg-q40'], [], JPEG40),
  ];
  return [...clean, ...busy, ...degraded];
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
async function assertFontAvailable(pg) {
  const ok = await pg.evaluate(() => {
    const c = document.createElement('canvas').getContext('2d');
    const probe = 'CERT 0123456789 GEM MT';
    c.font = '20px "Liberation Sans", monospace';
    const a = c.measureText(probe).width;
    c.font = '20px monospace';
    return Math.abs(a - c.measureText(probe).width) > 0.5;
  });
  if (!ok) {
    console.warn('WARNING: "Liberation Sans" is not installed; a fallback font is used and the output will not match the committed hashes.');
  }
  return ok;
}

async function renderSlab(pg, html) {
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((im) => im.decode()));
  });
  const overflow = await pg.evaluate(() =>
    [...document.querySelectorAll('.cgc-info > *, .cgcc-mid > *, .psa-label .left > *')].some((el) => el.scrollWidth > el.clientWidth + 1));
  if (overflow) throw new Error('Label text overflows its box; adjust layout');
  const labelBox = await pg.evaluate(() => {
    const label = document.querySelector('.label');
    if (!label) return null;
    const s = document.getElementById('shot').getBoundingClientRect();
    const r = label.getBoundingClientRect();
    return { x: Math.round(r.left - s.left), y: Math.round(r.top - s.top), width: Math.round(r.width), height: Math.round(r.height) };
  });
  const png = await pg.locator('#shot').screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css' });
  return { png, labelBox };
}

async function deriveImage(pg, srcBuf, t) {
  await pg.setContent(page(''), { waitUntil: 'load' });
  const url = await pg.evaluate(async ({ b64, t }) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    const src = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    if (t.type === 'downscale') {
      const w = t.width;
      const h = Math.round((src.height * w) / src.width);
      const small = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(small, 0, 0);
    } else if (t.type === 'rotate') {
      const rad = (t.degrees * Math.PI) / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      canvas.width = Math.ceil(src.width * cos + src.height * sin) + 2 * t.margin;
      canvas.height = Math.ceil(src.width * sin + src.height * cos) + 2 * t.margin;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = t.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rad);
      ctx.drawImage(src, -src.width / 2, -src.height / 2);
    } else {
      throw new Error(`unknown transform ${t.type}`);
    }
    return canvas.toDataURL(t.format, t.quality);
  }, { b64: srcBuf.toString('base64'), t });
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

/** Apply benchmark degradations (canvas only; seeded PRNG for noise) and encode. */
async function deriveBench(pg, srcBuf, ops, encode) {
  await pg.setContent(page(''), { waitUntil: 'load' });
  const url = await pg.evaluate(async ({ b64, ops, encode }) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const src = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const fresh = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    let canvas = fresh(src.width, src.height);
    canvas.getContext('2d').drawImage(src, 0, 0);
    const mulberry32 = (a) => () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (const o of ops) {
      const W = canvas.width;
      const H = canvas.height;
      if (o.op === 'scale') {
        const w = Math.round(W * o.factor);
        const h = Math.round(H * o.factor);
        const bmp = await createImageBitmap(canvas, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        const c = fresh(w, h);
        c.getContext('2d').drawImage(bmp, 0, 0);
        canvas = c;
      } else if (o.op === 'blur' || o.op === 'tone') {
        const c = fresh(W, H);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#e6e3dc';
        ctx.fillRect(0, 0, W, H);
        ctx.filter = o.op === 'blur' ? `blur(${o.px}px)` : `brightness(${o.brightness}) contrast(${o.contrast})`;
        ctx.drawImage(canvas, 0, 0);
        canvas = c;
      } else if (o.op === 'glare') {
        const ctx = canvas.getContext('2d');
        const x = o.cx * W;
        const y = o.cy * H;
        const g = ctx.createRadialGradient(x, y, 0, x, y, o.r * W);
        g.addColorStop(0, `rgba(255,255,255,${o.alpha})`);
        g.addColorStop(0.45, `rgba(255,255,255,${(o.alpha * 0.6).toFixed(3)})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        // Soft diagonal streak, as from a ceiling light on the plastic case.
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-Math.PI / 5);
        const band = o.r * W * 0.35;
        const lg = ctx.createLinearGradient(0, -band, 0, band);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(0.5, `rgba(255,255,255,${(o.alpha * 0.5).toFixed(3)})`);
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = lg;
        ctx.fillRect(-W, -band, 2 * W, 2 * band);
        ctx.restore();
      } else if (o.op === 'noise') {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const img = ctx.getImageData(0, 0, W, H);
        const rnd = mulberry32(o.seed);
        for (let i = 0; i < img.data.length; i += 4) {
          const n = Math.round((rnd() * 2 - 1) * o.amount);
          img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
        }
        ctx.putImageData(img, 0, 0);
      } else if (o.op === 'rotate') {
        const rad = (o.degrees * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const c = fresh(Math.ceil(W * cos + H * sin) + 2 * o.margin, Math.ceil(W * sin + H * cos) + 2 * o.margin);
        const ctx = c.getContext('2d');
        ctx.fillStyle = o.background;
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate(rad);
        ctx.drawImage(canvas, -W / 2, -H / 2);
        canvas = c;
      } else {
        throw new Error(`unknown op ${o.op}`);
      }
    }
    return canvas.toDataURL(encode.format, encode.quality);
  }, { b64: srcBuf.toString('base64'), ops, encode });
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

/** Label box after ops: scaled with 'scale', unchanged by filters, null after rotation. */
function benchBox(box, ops) {
  let b = box;
  for (const o of ops) {
    if (!b) return null;
    if (o.op === 'rotate') return null;
    if (o.op === 'scale') b = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v * o.factor)]));
  }
  return b;
}

async function generateBench(outDir, browser, env) {
  const dir = path.join(outDir, BENCH_SUBDIR);
  await mkdir(dir, { recursive: true });
  const specs = benchSpecs(await makeBenchBarcodes());
  const ids = new Set();
  for (const s of specs) { if (ids.has(s.id)) throw new Error(`duplicate bench id ${s.id}`); ids.add(s.id); }
  // Remove files left over from an older spec list.
  const keep = new Set([...specs.map((s) => s.file), 'bench-manifest.json']);
  for (const f of await readdir(dir)) if (!keep.has(f) && /\.(png|jpe?g)$/i.test(f)) await rm(path.join(dir, f));

  const ctx = await newContext(browser);
  const pg = await ctx.newPage();
  const buffers = {};
  const boxes = {};
  for (const s of specs) {
    let buf;
    if (s.html) {
      const r = await renderSlab(pg, s.html);
      buf = r.png;
      boxes[s.id] = r.labelBox;
    } else {
      buf = await deriveBench(pg, buffers[s.from], s.ops, s.encode);
      boxes[s.id] = benchBox(boxes[s.from], s.ops);
    }
    buffers[s.id] = buf;
    await writeFile(path.join(dir, s.file), buf);
  }
  await ctx.close();
  console.log(`wrote ${specs.length} benchmark fixtures to ${BENCH_SUBDIR}/`);

  const counts = specs.reduce((m, s) => ({ ...m, [s.category]: (m[s.category] ?? 0) + 1 }), {});
  const manifest = {
    schemaVersion: 1,
    generator: 'scripts/gen-fixtures.mjs',
    synthetic: true,
    notice: 'Synthetic HTML/CSS renders for the OCR benchmark (ADR-001 §14, D3). Grader names are plain printed text; card/comic art is abstract; names, titles and publishers are fictional. Cert numbers are test values. Never load live grader pages from tests.',
    environment: env,
    gate: { top1CleanMin: 0.9, top1DegradedMin: 0.7, wrongAutoOpensMax: 0 },
    metrics: {
      top1: 'For fixtures with expected.number: the panel\'s top (selected) candidate equals expected.number exactly (leading zeros kept). Reported separately for category clean and degraded; negatives are excluded.',
      wrongAutoOpen: 'An automatically opened tab whose URL differs from the official URL built from expected.grader + expected.number, or any auto-open on a mustNotAutoOpen fixture. Hard blocker.',
      autoOpenPrecision: 'correct auto-opens / all auto-opens.',
    },
    evaluation: EVALUATION_RULE,
    counts: { total: specs.length, ...counts },
    totalBytes: Object.values(buffers).reduce((n, b) => n + b.length, 0),
    fixtures: specs.map((s) => {
      const b = buffers[s.id];
      const { width, height, type } = imageSize(b);
      return {
        id: s.id,
        file: s.file,
        category: s.category,
        degradations: s.degradations,
        description: s.description,
        expected: s.expected,
        accept: s.accept,
        ...(s.graderUnresolved ? { graderUnresolved: true } : {}),
        ...(s.mustNotAutoOpen ? { mustNotAutoOpen: true } : {}),
        tags: s.tags,
        ...(s.notes ? { notes: s.notes } : {}),
        labelText: s.labelText,
        labelBox: boxes[s.id],
        barcode: s.barcode,
        ...(s.from ? { derivedFrom: s.from, ops: s.ops, encode: s.encode } : {}),
        mimeType: type,
        width,
        height,
        bytes: b.length,
        sha256: sha256(b),
      };
    }),
  };
  await writeFile(path.join(dir, 'bench-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${BENCH_SUBDIR}/bench-manifest.json (${specs.length} fixtures, ${(manifest.totalBytes / 1024 / 1024).toFixed(2)} MiB)`);
}

async function verifyBench(outDir, browser) {
  const failures = [];
  const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
  const dir = path.join(outDir, BENCH_SUBDIR);
  const manifest = JSON.parse(await readFile(path.join(dir, 'bench-manifest.json'), 'utf8'));
  console.log(`\nVerify ${dir}`);
  let total = 0;
  for (const f of manifest.fixtures) {
    const buf = await readFile(path.join(dir, f.file));
    total += buf.length;
    const dim = imageSize(buf);
    if (buf.length >= MAX_BYTES) fail(`bench/${f.file}: ${buf.length} bytes >= ${MAX_BYTES}`);
    if (sha256(buf) !== f.sha256) fail(`bench/${f.file}: sha256 differs from manifest`);
    if (dim.width !== f.width || dim.height !== f.height) fail(`bench/${f.file}: header ${dim.width}x${dim.height} != manifest`);
    if (dim.type !== f.mimeType) fail(`bench/${f.file}: type ${dim.type} != ${f.mimeType}`);
    if (f.expected.number !== null && !/^\d{7,13}$/.test(f.expected.number)) fail(`bench/${f.file}: bad expected number`);
  }
  const extra = (await readdir(dir)).filter((x) => /\.(png|jpe?g)$/i.test(x) && !manifest.fixtures.some((f) => f.file === x));
  if (extra.length) fail(`bench: files not in manifest: ${extra.join(', ')}`);
  if (total >= BENCH_MAX_TOTAL) fail(`bench: total ${total} bytes >= ${BENCH_MAX_TOTAL}`);
  if (manifest.fixtures.length < 40) fail(`bench: only ${manifest.fixtures.length} fixtures (< 40)`);
  console.log(`  ${manifest.fixtures.length} fixtures, ${(total / 1024 / 1024).toFixed(2)} MiB (budget ${BENCH_MAX_TOTAL / 1024 / 1024} MiB); categories ${JSON.stringify(manifest.counts)}`);

  const server = await startServer(dir);
  const port = server.address().port;
  const ctx = await newContext(browser, { width: 1280, height: 800 });
  try {
    const pg = await ctx.newPage();
    await pg.goto(`http://127.0.0.1:${port}/__verify.html`);
    await pg.evaluate(async () => {
      await ZXingWASM.prepareZXingModule({
        overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? `/__zxing/${p}` : prefix + p) },
        fireImmediately: true,
      });
    });
    for (const f of manifest.fixtures) {
      const r = await pg.evaluate(async (file) => {
        const url = `/fixtures/${file}`;
        const img = new Image();
        img.src = url;
        await img.decode();
        const blob = await (await fetch(url)).blob();
        const rs = (await ZXingWASM.readBarcodes(blob, { maxNumberOfSymbols: 8 })).filter((x) => x.isValid).map((x) => ({ format: x.format, text: x.text }));
        return { w: img.naturalWidth, h: img.naturalHeight, rs };
      }, f.file);
      if (r.w !== f.width || r.h !== f.height) fail(`bench/${f.file}: browser decoded ${r.w}x${r.h}`);
      const decoded = r.rs.map((x) => `${x.format}:"${x.text}"`).join(', ') || '-';
      if (f.barcode && !f.derivedFrom) {
        if (r.rs.length !== 1 || r.rs[0].format !== f.barcode.format || r.rs[0].text !== f.barcode.text) fail(`bench/${f.file}: expected ${f.barcode.format} "${f.barcode.text}", got ${decoded}`);
      } else if (!f.barcode && r.rs.length) {
        fail(`bench/${f.file}: unexpected symbol(s) ${decoded}`);
      }
      if (f.barcode && f.derivedFrom) console.log(`  ${f.file.padEnd(28)} barcode after degradation: ${decoded}`);
    }
  } finally {
    await ctx.close();
    server.close();
  }
  console.log(failures.length ? `\nBENCH VERIFY FAILED (${failures.length})` : '\nBENCH VERIFY OK');
  return failures.length === 0;
}

// ---------------------------------------------------------------------------------------------
// e2e pages (synthetic marketplace listing)
// ---------------------------------------------------------------------------------------------
function pageEntries(sizes) {
  const disp = (file, width) => ({ width, height: Math.round((sizes[file].height * width) / sizes[file].width) });
  return [
    { elementId: 'img-psa-leading-zero', kind: 'img', fixture: 'psa-8digit-leading-zero.png', contextMenu: 'image', display: disp('psa-8digit-leading-zero.png', 270),
      notes: 'Plain <img>, scaled down to 270 px CSS width (natural size is larger). Journey 1.' },
    { elementId: 'img-srcset', kind: 'img-srcset', fixture: 'psa-lowres.jpg', largestCandidate: 'psa-8digit-leading-zero.png', contextMenu: 'image', display: disp('psa-lowres.jpg', 260),
      notes: 'src/currentSrc at DPR 1 is the 260 px JPEG; the srcset also offers the full-size PNG (largest candidate). Expected result is the PSA 01234567 read.' },
    { elementId: 'img-ambiguous', kind: 'img', fixture: 'ambiguous-10digit.png', contextMenu: 'image', display: disp('ambiguous-10digit.png', 270),
      notes: 'Must end in confirm with no tab opened.' },
    { elementId: 'img-qr-foreign', kind: 'img', fixture: 'qr-foreign-host.png', contextMenu: 'image', display: disp('qr-foreign-host.png', 270),
      notes: 'Security negative: evil.example must never be opened.' },
    { elementId: 'img-non-slab', kind: 'img', fixture: 'non-slab.png', contextMenu: 'image', display: disp('non-slab.png', 320),
      notes: 'No number found; no tab.' },
    { elementId: 'bg-psa-9digit', kind: 'css-background', fixture: 'psa-9digit.png', contextMenu: 'none', display: disp('psa-9digit.png', 270),
      notes: '<div role="img"> with a CSS background-image: Chrome offers no "image" context-menu entry here. Expected fallback: upload/paste or capture.' },
    { elementId: 'img-under-overlay', kind: 'img-under-overlay', overlayId: 'overlay-shield', fixture: 'cgc-comic-dash.png', contextMenu: 'none', display: disp('cgc-comic-dash.png', 300),
      notes: 'A transparent <div id="overlay-shield"> covers the image, so right-clicking it hits the overlay (no "image" context). Image itself is loaded.' },
    { elementId: 'img-data-url', kind: 'img-data-url', fixture: 'psa-lowres.jpg', contextMenu: 'image', display: disp('psa-lowres.jpg', 260),
      notes: 'Same bytes as psa-lowres.jpg inlined as a data: URL (srcUrl is a data: URL).' },
    { elementId: 'img-blob', kind: 'img-blob', fixture: 'cgc-comic-qr.png', contextMenu: 'image', display: disp('cgc-comic-qr.png', 300),
      notes: 'Inline script fetches the PNG and assigns a blob: URL; <html data-ready="1"> is set once it has loaded.' },
    { elementId: 'img-back-barcode', kind: 'img', fixture: 'psa-back-barcode.png', contextMenu: 'image', display: disp('psa-back-barcode.png', 270),
      notes: 'Displayed at about half size, so the on-screen barcode has ~1.5 px modules (capture fallback may fail to decode; full-resolution fetch should succeed).' },
    { elementId: 'img-rotated', kind: 'img', fixture: 'cgc-comic-rotated.png', contextMenu: 'image', display: disp('cgc-comic-rotated.png', 300),
      notes: 'Rotated label.' },
    { elementId: 'img-in-frame', frameId: 'frame-same-origin', framePage: 'pages/frame.html', kind: 'img-in-iframe', fixture: 'cgc-card-13digit.png', contextMenu: 'image', display: disp('cgc-card-13digit.png', 270),
      notes: 'Inside a same-origin <iframe id="frame-same-origin">. With ?frameOrigin=http://localhost:<port> (gallery served from 127.0.0.1) a second <iframe id="frame-cross-origin"> loads the same frame page cross-origin.' },
    { elementId: 'img-lazy', kind: 'img-lazy', fixture: 'cgc-comic-10digit.png', contextMenu: 'image', display: disp('cgc-comic-10digit.png', 300),
      notes: 'loading="lazy" below a 4000 px spacer: not fetched until scrolled near.' },
  ];
}

function galleryHtml(entries, lowresJpeg, sizes) {
  const byId = Object.fromEntries(entries.map((e) => [e.elementId, e]));
  const dims = (id) => `width="${byId[id].display.width}" height="${byId[id].display.height}"`;
  const tile = (id, inner, caption) => `<figure class="tile">${inner}<figcaption>${esc(caption)} <code>#${id}</code></figcaption></figure>`;
  const img = (id, alt, extra = '') => `<img id="${id}" data-fixture="${byId[id].fixture}" src="../${byId[id].fixture}" ${dims(id)} alt="${esc(alt)}"${extra}>`;
  const lo = byId['img-srcset'];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synthetic marketplace listing - CertScanner e2e gallery</title>
<style>
  body{font-family:"Liberation Sans",Arial,sans-serif;margin:0;background:#fafafa;color:#222}
  header{padding:16px 24px;background:#24313d;color:#fff}
  header h1{font-size:20px;margin:0 0 4px}
  header p{margin:0;font-size:13px;opacity:.85}
  main{display:flex;flex-wrap:wrap;gap:20px;padding:20px 24px;align-items:flex-start}
  .tile{margin:0;background:#fff;border:1px solid #ddd;border-radius:8px;padding:10px}
  .tile figcaption{font-size:12px;margin-top:6px;color:#555}
  .tile img{display:block}
  .bg-slab{background-size:100% 100%;background-repeat:no-repeat}
  .overlay-wrap{position:relative;display:inline-block}
  #overlay-shield{position:absolute;inset:0;background:transparent}
  .spacer{height:4000px;margin:0 24px;border-left:4px dashed #ccc;padding-left:12px;color:#888;font-size:13px}
  iframe{border:1px solid #ccc;background:#fff}
</style>
</head>
<body>
<header>
  <h1>Example listing: graded slab photos (synthetic test page)</h1>
  <p>Static fixture for CertScanner end-to-end tests. Every image is a synthetic render; no real items. Not affiliated with PSA or CGC.</p>
</header>
<main>
  ${tile('img-psa-leading-zero', img('img-psa-leading-zero', 'Synthetic PSA-style slab, front label'), 'Plain image')}
  ${tile('img-srcset', `<img id="img-srcset" data-fixture="${lo.fixture}" src="../${lo.fixture}" srcset="../${lo.fixture} ${sizes[lo.fixture].width}w, ../${lo.largestCandidate} ${sizes[lo.largestCandidate].width}w" sizes="${lo.display.width}px" ${dims('img-srcset')} alt="Synthetic PSA-style slab, responsive image">`, 'srcset (thumbnail + full size)')}
  ${tile('img-ambiguous', img('img-ambiguous', 'Synthetic slab with a plain label'), 'No grader words')}
  ${tile('img-qr-foreign', img('img-qr-foreign', 'Synthetic slab with an unknown QR code'), 'Foreign QR host')}
  ${tile('img-non-slab', img('img-non-slab', 'Landscape photo'), 'Not a slab')}
  ${tile('bg-psa-9digit', `<div id="bg-psa-9digit" class="bg-slab" data-fixture="${byId['bg-psa-9digit'].fixture}" role="img" aria-label="Synthetic PSA-style slab shown as a CSS background" style="width:${byId['bg-psa-9digit'].display.width}px;height:${byId['bg-psa-9digit'].display.height}px;background-image:url('../${byId['bg-psa-9digit'].fixture}')"></div>`, 'CSS background (no image context)')}
  ${tile('img-under-overlay', `<div class="overlay-wrap">${img('img-under-overlay', 'Synthetic CGC-style comic slab under an overlay')}<div id="overlay-shield" aria-hidden="true"></div></div>`, 'Image under a transparent overlay')}
  ${tile('img-data-url', `<img id="img-data-url" data-fixture="${byId['img-data-url'].fixture}" src="data:image/jpeg;base64,${lowresJpeg.toString('base64')}" ${dims('img-data-url')} alt="Synthetic PSA-style slab, inline data URL">`, 'data: URL')}
  ${tile('img-blob', `<img id="img-blob" data-fixture="${byId['img-blob'].fixture}" ${dims('img-blob')} alt="Synthetic CGC-style comic slab with QR, blob URL">`, 'blob: URL')}
  ${tile('img-back-barcode', img('img-back-barcode', 'Synthetic PSA-style slab, back label with barcode'), 'Back label barcode')}
  ${tile('img-rotated', img('img-rotated', 'Synthetic CGC-style comic slab, rotated'), 'Rotated photo')}
  <figure class="tile"><iframe id="frame-same-origin" src="frame.html" title="Seller photo (same-origin frame)" width="${byId['img-in-frame'].display.width + 24}" height="${byId['img-in-frame'].display.height + 24}"></iframe><figcaption>Same-origin iframe <code>#frame-same-origin</code></figcaption></figure>
  <figure class="tile" id="cross-origin-slot" hidden><figcaption>Cross-origin iframe <code>#frame-cross-origin</code></figcaption></figure>
</main>
<div class="spacer">More photos further down (lazy-loaded image below)...</div>
<main>
  ${tile('img-lazy', img('img-lazy', 'Synthetic CGC-style comic slab, lazy-loaded', ' loading="lazy"'), 'loading="lazy"')}
</main>
<script>
(async () => {
  // Optional cross-origin copy of frame.html: gallery.html?frameOrigin=http://localhost:<port>
  const origin = new URLSearchParams(location.search).get('frameOrigin');
  if (origin && /^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$/.test(origin)) {
    const slot = document.getElementById('cross-origin-slot');
    const f = document.createElement('iframe');
    f.id = 'frame-cross-origin';
    f.title = 'Seller photo (cross-origin frame)';
    f.width = '${byId['img-in-frame'].display.width + 24}';
    f.height = '${byId['img-in-frame'].display.height + 24}';
    f.src = origin + new URL('frame.html', location.href).pathname;
    slot.prepend(f);
    slot.hidden = false;
  }
  const img = document.getElementById('img-blob');
  const blob = await (await fetch('../' + img.dataset.fixture)).blob();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  document.documentElement.dataset.ready = '1';
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// Security fixtures (docs/quality/security-review.md)
// ---------------------------------------------------------------------------------------------
/** SEC-03: hostile page that blocks its own main thread after the image has rendered. */
function busyHtml() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Hostile page: busy main thread (synthetic)</title>
<style>body{margin:0;padding:16px;font-family:"Liberation Sans",Arial,sans-serif;background:#fff}img{display:block}</style></head>
<body>
<h1 style="font-size:16px;margin:0 0 8px">Hostile test page: blocks its main thread (SEC-03)</h1>
<img id="img-busy" data-fixture="psa-8digit-leading-zero.png" width="400" alt="Synthetic PSA-style slab on a hostile page">
<script>
(() => {
  // ?img=<http(s) URL> (default ../psa-8digit-leading-zero.png), ?delay=<ms after decode, default 500>,
  // ?ms=<blocking duration, default 30000, max 120000>. <html data-ready="1"> after decode, data-busy="1" while blocked.
  const q = new URLSearchParams(location.search);
  const img = document.getElementById('img-busy');
  const src = q.get('img');
  img.src = src && /^https?:\\/\\//.test(src) ? src : '../psa-8digit-leading-zero.png';
  const delay = Math.min(Math.max(Number(q.get('delay') ?? 500) || 0, 0), 10000);
  const ms = Math.min(Math.max(Number(q.get('ms') ?? 30000) || 0, 0), 120000);
  img.decode().catch(() => {}).finally(() => {
    document.documentElement.dataset.ready = '1';
    setTimeout(() => {
      document.documentElement.dataset.busy = '1';
      const end = Date.now() + ms;
      while (Date.now() < end) { /* hostile: never yields to the event loop */ }
      document.documentElement.dataset.busy = 'done';
    }, delay);
  });
})();
</script>
</body>
</html>
`;
}

/**
 * SEC-04: decompression bomb. A 1,080-byte BI_RLE8 BMP whose header declares 16000x16000 px (256 MP,
 * ~1 GB RGBA once decoded); the pixel data is just the RLE "end of bitmap" escape.
 */
function rle8BombBmp(width = 16000, height = 16000) {
  const paletteBytes = 256 * 4;
  const data = Buffer.from([0x00, 0x01]); // RLE8 escape: end of bitmap
  const offset = 14 + 40 + paletteBytes;
  const buf = Buffer.alloc(offset + data.length);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(offset, 10);
  buf.writeUInt32LE(40, 14);          // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);           // planes
  buf.writeUInt16LE(8, 28);           // bits per pixel
  buf.writeUInt32LE(1, 30);           // BI_RLE8
  buf.writeUInt32LE(data.length, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(256, 46);
  buf.writeUInt32LE(0, 50);
  for (let i = 0; i < 256; i++) buf.writeUInt32LE((i << 16) | (i << 8) | i, 54 + i * 4); // grey palette
  data.copy(buf, offset);
  return buf;
}

/**
 * SEC-14: baseline JPEG whose frame header (SOF0, 16000x16000) sits beyond the first 64 KiB, behind two COM segments.
 * A header sniff of only the first 64 KiB finds no size; the file is far below 256 KiB, so the pre-SEC-14 rule
 * ("unknown size and small: decode") would have decoded it. Tables and a few entropy bytes make it decodable, so a
 * regression would allocate ~1 GB of pixels instead of refusing.
 */
function jpegSofAfterHead({ width = 16000, height = 16000, padSegments = 2, padBytes = 36000 } = {}) {
  const seg = (marker, payload) => {
    const b = Buffer.alloc(4 + payload.length);
    b[0] = 0xff;
    b[1] = marker;
    b.writeUInt16BE(payload.length + 2, 2);
    Buffer.from(payload).copy(b, 4);
    return b;
  };
  const pad = Buffer.alloc(padBytes, 'CertScanner SEC-14 synthetic padding: the frame header lies beyond the first 64 KiB. ', 'ascii');
  const counts = (n1) => [n1, ...new Array(15).fill(0)];
  const parts = [
    Buffer.from([0xff, 0xd8]), // SOI
    seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), // APP0 JFIF 1.1
    ...new Array(padSegments).fill(0).map(() => seg(0xfe, pad)), // COM padding
    seg(0xdb, [0x00, ...new Array(64).fill(1)]), // DQT table 0
  ];
  const sofOffset = parts.reduce((n, b) => n + b.length, 0);
  parts.push(
    seg(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]), // SOF0
    seg(0xc4, [0x00, ...counts(1), 0x00]), // DHT DC 0: one 1-bit code for category 0
    seg(0xc4, [0x10, ...counts(1), 0x00]), // DHT AC 0: one 1-bit code for EOB
    seg(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]), // SOS
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // entropy-coded data: flat blocks
    Buffer.from([0xff, 0xd9]), // EOI
  );
  return { buf: Buffer.concat(parts), sofOffset };
}

/**
 * SEC-14: GIF whose logical screen is 10x10 but whose only frame is 16000x16000 (Chrome sizes the canvas to the
 * frame). LZW data is just clear + end-of-information, so a decoder would allocate the full frame.
 */
function gifFrameLargerThanScreen({ screen = 10, frame = 16000 } = {}) {
  const u16 = (v) => [v & 0xff, v >> 8];
  return Buffer.from([
    ...Buffer.from('GIF89a', 'ascii'), ...u16(screen), ...u16(screen), 0x80, 0x00, 0x00, // screen, 2-entry colour table
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
    0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // graphic control extension
    0x2c, ...u16(0), ...u16(0), ...u16(frame), ...u16(frame), 0x00, // image descriptor
    0x02, 0x01, 0x2c, 0x00, // LZW min code size 2; one sub-block: clear (4), EOI (5); terminator
    0x3b, // trailer
  ]);
}

const SECURITY_FIXTURES = [
  {
    file: 'security/decode-bomb-rle8.bmp',
    make: () => rle8BombBmp(),
    finding: 'SEC-04',
    description: 'BI_RLE8 BMP of 1,080 bytes declaring 16000x16000 px (256 MP); pixel data is only the end-of-bitmap escape.',
    declared: { width: 16000, height: 16000 },
    expected: { status: 'error', error: 'too-large', maxSettleMs: 2000 },
    mimeType: 'image/bmp',
  },
  {
    file: 'security/jpeg-sof-after-64k.jpg',
    make: () => jpegSofAfterHead().buf,
    finding: 'SEC-14',
    description: 'Baseline JPEG (~72 KB) declaring 16000x16000 px (256 MP) in a SOF0 placed after 64 KiB of COM segments; decodable tables and flat entropy data.',
    declared: { width: 16000, height: 16000 },
    structure: { sofOffset: jpegSofAfterHead().sofOffset, headBytes: 65536, unknownSizeLimitBytes: 262144 },
    expected: { status: 'error', error: 'too-large', maxSettleMs: 2000 },
    mimeType: 'image/jpeg',
  },
  {
    file: 'security/gif-frame-larger-than-screen.gif',
    make: () => gifFrameLargerThanScreen(),
    finding: 'SEC-14',
    description: 'GIF89a with a 10x10 logical screen and one 16000x16000 frame (LZW clear + end only).',
    declared: { width: 16000, height: 16000 },
    structure: { screen: { width: 10, height: 10 }, frame: { width: 16000, height: 16000 } },
    expected: { status: 'error', error: 'too-large', maxSettleMs: 2000 },
    mimeType: 'image/gif',
  },
];

function frameHtml(entry) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Seller photo (synthetic frame)</title>
<style>body{margin:0;padding:12px;background:#fff;font-family:"Liberation Sans",Arial,sans-serif}img{display:block}</style></head>
<body>
<img id="${entry.elementId}" data-fixture="${entry.fixture}" src="../${entry.fixture}" width="${entry.display.width}" height="${entry.display.height}" alt="Synthetic CGC-style card slab inside a frame">
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// A9 page scan: single-slab marketplace listing (pages/listing.html + pages/assets/*)
// ---------------------------------------------------------------------------------------------
// Discovery thresholds from ADR-001 A9 (pageImagesProbe): rendered short side >= 120 CSS px and natural short
// side >= 150 px. Used only to declare which listing images a page scan is expected to consider.
const A9_MIN_RENDERED = 120;
const A9_MIN_NATURAL = 150;
const LISTING_SLAB = 'psa-9digit.png';
const LISTING_RAW = 'non-slab.png';
const LISTING_CERT_URL = 'https://www.psacard.com/cert/108114622';
// Numbers printed as page text (and, with ?details=1, inside an image). None of them is a cert number.
const LISTING_TEXT_NUMBERS = Object.freeze({
  price: 'US $1,299.00', itemNumber: '2023041712', sellerId: '48213576', ratings: '12,345', cardNumber: '58/102', year: '1999',
  watchers: '17', shipping: '3 business days', returns: '30 days',
});
const LISTING_PROMO_CODE = 'FALL2026'; // printed in the banner image and its alt text only
const LISTING_MUST_NOT_OPEN_NUMBERS = Object.freeze(['2023041712', '48213576', '129900', '1299', '12345', '58102', '1999']);

const assetPage = (inner, css = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{background:#fff}
body{font-family:${LABEL_FONT};-webkit-font-smoothing:antialiased}#shot{display:inline-block}${css}
</style></head><body>${inner}</body></html>`;

/** Non-slab listing images (all synthetic; no logos of real companies, no grader names). */
function listingAssetSpecs() {
  return [
    {
      file: 'pages/assets/listing-logo.png', role: 'logo', elementId: 'img-logo', display: { width: 48, height: 48 },
      description: 'Shop logo: 96x96 rounded square with the letters "CS". Shown at 48 px: below the A9 size threshold.',
      html: assetPage('<div id="shot"><div class="logo">CS</div></div>',
        '.logo{width:96px;height:96px;border-radius:20px;background:#0f5c63;color:#fff;font-weight:700;font-size:44px;display:flex;align-items:center;justify-content:center;letter-spacing:1px}'),
    },
    {
      file: 'pages/assets/listing-avatar.png', role: 'avatar', elementId: 'img-avatar', display: { width: 64, height: 64 },
      description: 'Seller avatar: 128x128 initials "JD" on a grey disc. Shown at 64 px: below the A9 size threshold.',
      html: assetPage('<div id="shot"><div class="av">JD</div></div>',
        '#shot{background:#fff}.av{width:128px;height:128px;border-radius:64px;background:#c9ced6;color:#33404d;font-weight:700;font-size:48px;display:flex;align-items:center;justify-content:center}'),
    },
    {
      file: 'pages/assets/listing-banner.png', role: 'banner', elementId: 'img-banner', display: { width: 728, height: 90 },
      description: 'Promotion banner 728x90 with printed digits ("$50", "FALL2026"). Natural short side 90 px: below the A9 size threshold.',
      html: assetPage(`<div id="shot"><div class="bn"><b>FREE SHIPPING</b> on orders over $50 &middot; use code ${LISTING_PROMO_CODE}</div></div>`,
        '.bn{width:728px;height:90px;background:linear-gradient(90deg,#ffe7a3,#ffd0c2);color:#5a2b00;font-size:26px;display:flex;align-items:center;justify-content:center;gap:8px}'),
    },
    {
      file: 'pages/assets/listing-details.png', role: 'details', elementId: 'img-details', display: { width: 390, height: 210 },
      description: 'Item-specifics panel as an image (only with ?details=1): printed item number 2023041712, price US $1,299.00, seller ID 48213576, card no. 58/102, year 1999. No slab wording. Large enough for A9 discovery, so the page scan OCRs it.',
      html: assetPage(`<div id="shot"><div class="spec"><div class="h">ITEM SPECIFICS</div><table>
<tr><td>Item number</td><td>${LISTING_TEXT_NUMBERS.itemNumber}</td></tr>
<tr><td>Price</td><td>${esc(LISTING_TEXT_NUMBERS.price)}</td></tr>
<tr><td>Seller ID</td><td>${LISTING_TEXT_NUMBERS.sellerId}</td></tr>
<tr><td>Card no. / Year</td><td>${LISTING_TEXT_NUMBERS.cardNumber} &middot; ${LISTING_TEXT_NUMBERS.year}</td></tr>
</table></div></div>`,
      '.spec{width:520px;height:280px;background:#fff;border:2px solid #c8ccd4;padding:18px 24px;color:#222}.h{font-size:22px;font-weight:700;margin-bottom:10px;letter-spacing:.5px}table{border-collapse:collapse;font-size:21px;line-height:1.75}td:first-child{padding-right:28px;color:#555}'),
    },
  ];
}

async function renderAsset(pg, html) {
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.evaluate(async () => { await document.fonts.ready; });
  return pg.locator('#shot').screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css' });
}

function listingHtml(sizes) {
  const disp = (file, width) => ({ width, height: Math.round((sizes[file].height * width) / sizes[file].width) });
  const slab = disp(LISTING_SLAB, 400);
  const thumbSlab = disp(LISTING_SLAB, 64);
  const raw = disp(LISTING_RAW, 320);
  const thumbRaw = disp(LISTING_RAW, 64);
  const n = LISTING_TEXT_NUMBERS;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synthetic single-slab listing - CertScanner e2e (page scan)</title>
<style>
  body{margin:0;font-family:"Liberation Sans",Arial,sans-serif;background:#fff;color:#222}
  img{display:block}
  .site{display:flex;align-items:center;gap:12px;height:64px;padding:0 24px;border-bottom:1px solid #ddd}
  .site .name{font-weight:700;font-size:18px}
  .promo{padding:8px 24px}
  .listing{display:flex;gap:32px;padding:8px 24px;align-items:flex-start}
  .photos{display:flex;gap:12px;align-items:flex-start}
  .thumbs{display:flex;flex-direction:column;gap:8px}
  .thumbs img{outline:1px solid #ccc}
  figure{margin:0}
  .details{width:520px}
  .details h1{font-size:20px;margin:0 0 8px;line-height:1.3}
  .price{font-size:26px;font-weight:700;margin:4px 0}
  .muted{color:#666;font-size:14px;margin:2px 0 10px}
  dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:14px;margin:0 0 12px}
  dt{color:#666}dd{margin:0}
  .seller{display:flex;align-items:center;gap:10px;font-size:14px;margin:0 0 12px}
  .details h2{font-size:15px;margin:8px 0 6px}
</style>
</head>
<body>
<header class="site"><img id="img-logo" src="assets/listing-logo.png" width="48" height="48" alt="Example Card Shop logo"><span class="name">Example Card Shop (synthetic test page, not affiliated with PSA or CGC)</span></header>
<div class="promo"><img id="img-banner" src="assets/listing-banner.png" width="728" height="90" alt="Promotion: free shipping on orders over $50, code ${LISTING_PROMO_CODE}"></div>
<main class="listing">
  <section class="photos" aria-label="Photos">
    <div class="thumbs">
      <img id="img-thumb-slab" data-fixture="${LISTING_SLAB}" src="../${LISTING_SLAB}" width="${thumbSlab.width}" height="${thumbSlab.height}" alt="Thumbnail 1: slab front">
      <img id="img-thumb-raw" data-fixture="${LISTING_RAW}" src="../${LISTING_RAW}" width="${thumbRaw.width}" height="${thumbRaw.height}" alt="Thumbnail 2: raw card">
    </div>
    <figure><img id="img-slab" data-fixture="${LISTING_SLAB}" src="../${LISTING_SLAB}" width="${slab.width}" height="${slab.height}" alt="Synthetic PSA-style slab, front label (listing photo)"></figure>
  </section>
  <section class="details">
    <h1>Synthetic graded trading card in a PSA-style slab (test listing)</h1>
    <p class="price" id="price">${esc(n.price)}</p>
    <p class="muted">or Best Offer &middot; ${n.watchers} watchers &middot; Free shipping</p>
    <dl>
      <dt>Item number</dt><dd id="item-number">${n.itemNumber}</dd>
      <dt>Condition</dt><dd>Graded (see photos)</dd>
      <dt>Card number</dt><dd>${n.cardNumber}</dd>
      <dt>Year</dt><dd>${n.year}</dd>
      <dt>Shipping</dt><dd>Ships within ${n.shipping}</dd>
      <dt>Returns</dt><dd>Accepted within ${n.returns}</dd>
    </dl>
    <div class="seller"><img id="img-avatar" src="assets/listing-avatar.png" width="64" height="64" alt="Seller avatar"><span>Seller ID ${n.sellerId} &middot; 99.8% positive (${n.ratings} ratings)</span></div>
    <figure id="details-figure" hidden><img id="img-details" data-src="assets/listing-details.png" width="390" height="210" alt="Item specifics (image)"></figure>
    <h2>Also in this listing</h2>
    <figure><img id="img-raw-card" data-fixture="${LISTING_RAW}" src="../${LISTING_RAW}" width="${raw.width}" height="${raw.height}" alt="Raw card photo (not graded)"></figure>
  </section>
</main>
<script>
(async () => {
  // ?slab=0 removes the slab photo and its thumbnail; ?photos=0 removes the slab and the raw-card photo (and thumbnails);
  // ?details=1 shows an item-specifics image with printed price/item/seller numbers. <html data-ready="1"> once decoded.
  const q = new URLSearchParams(location.search);
  const drop = (id) => document.getElementById(id)?.remove();
  if (q.get('slab') === '0' || q.get('photos') === '0') { drop('img-slab'); drop('img-thumb-slab'); }
  if (q.get('photos') === '0') { drop('img-raw-card'); drop('img-thumb-raw'); }
  if (q.get('details') === '1') {
    const im = document.getElementById('img-details');
    im.src = im.dataset.src;
    document.getElementById('details-figure').hidden = false;
  }
  await Promise.all([...document.images].filter((im) => im.getAttribute('src')).map((im) => im.decode().catch(() => {})));
  document.documentElement.dataset.ready = '1';
})();
</script>
</body>
</html>
`;
}

function listingManifestEntry(sizes, assets) {
  const disp = (file, width) => ({ width, height: Math.round((sizes[file].height * width) / sizes[file].width) });
  const discoverable = (d, nat) => Math.min(d.width, d.height) >= A9_MIN_RENDERED && Math.min(nat.width, nat.height) >= A9_MIN_NATURAL;
  const img = (elementId, role, src, display, natural, extra = {}) => ({ elementId, role, src, display, natural, discoverable: discoverable(display, natural), ...extra });
  const nat = (file) => ({ width: sizes[file].width, height: sizes[file].height });
  const images = [
    ...assets.filter((a) => a.role !== 'details').map((a) => img(a.elementId, a.role, a.file.replace(/^pages\//, ''), a.display, { width: a.width, height: a.height })),
    img('img-thumb-slab', 'thumbnail', `../${LISTING_SLAB}`, disp(LISTING_SLAB, 64), nat(LISTING_SLAB), { fixture: LISTING_SLAB, removedBy: ['slab=0', 'photos=0'] }),
    img('img-thumb-raw', 'thumbnail', `../${LISTING_RAW}`, disp(LISTING_RAW, 64), nat(LISTING_RAW), { fixture: LISTING_RAW, removedBy: ['photos=0'] }),
    img('img-slab', 'slab', `../${LISTING_SLAB}`, disp(LISTING_SLAB, 400), nat(LISTING_SLAB), { fixture: LISTING_SLAB, removedBy: ['slab=0', 'photos=0'] }),
    img('img-raw-card', 'raw-photo', `../${LISTING_RAW}`, disp(LISTING_RAW, 320), nat(LISTING_RAW), { fixture: LISTING_RAW, removedBy: ['photos=0'] }),
    ...assets.filter((a) => a.role === 'details').map((a) => img(a.elementId, a.role, a.file.replace(/^pages\//, ''), a.display, { width: a.width, height: a.height }, { addedBy: ['details=1'] })),
  ];
  return {
    page: 'pages/listing.html', elementId: 'img-slab', kind: 'single-slab-listing', feature: 'A9 page scan', fixture: LISTING_SLAB,
    contextMenu: 'image', display: disp(LISTING_SLAB, 400),
    params: {
      slab: '0 removes the slab photo and its thumbnail',
      photos: '0 removes the slab and the raw-card photo (and both thumbnails): no slab-sized photo left',
      details: '1 shows an item-specifics image with printed price/item/seller numbers (large enough for discovery)',
    },
    images,
    textNumbers: LISTING_TEXT_NUMBERS,
    mustNeverAutoOpenNumbers: LISTING_MUST_NOT_OPEN_NUMBERS,
    expected: {
      default: { status: 'auto-open', url: LISTING_CERT_URL, grader: 'psa', number: '108114622', discovered: ['img-slab', 'img-raw-card'], tabsOpened: 1 },
      'slab=0': { status: 'none', reason: 'photos checked, no number', discovered: ['img-raw-card'], tabsOpened: 0 },
      'photos=0': { status: 'none', reason: 'no slab-sized photo', discovered: [], tabsOpened: 0 },
      'details=1': { accept: ['auto-open', 'page-results'], onlyAutoOpenUrl: LISTING_CERT_URL, discovered: ['img-slab', 'img-raw-card', 'img-details'] },
      'slab=0&details=1': { accept: ['none', 'page-results'], mustNotAutoOpen: true, tabsOpened: 0, discovered: ['img-raw-card', 'img-details'] },
    },
    notes: 'A9 single-slab listing: one PSA-style slab photo (psa-9digit.png at 400 px), a 64 px thumbnail of the same file earlier in the DOM (same URL; too small), a raw-card photo, a logo, an avatar and a promo banner (all too small for discovery), plus page text with a price, an item number (10 digits) and a seller ID (8 digits, PSA length). Page scans read image URLs/geometry only, never page text. <html data-ready="1"> after all images decoded. Expected numbers assume the e2e viewport (--window-size=1280,1000).',
  };
}

// ---------------------------------------------------------------------------------------------
// SEC-13: hostile page that shows slab A as a CSS background and hides an <img> of slab B (pages/hidden.html)
// ---------------------------------------------------------------------------------------------
// The user sees slab A; the only discoverable image is B, hidden in one of several ways. A page scan must never
// auto-open B's cert in a hiding variant (list or none). `none` is the control: B visible -> B auto-opens.
const HIDDEN_A = 'psa-9digit.png';
const HIDDEN_B = 'psa-8digit-leading-zero.png';
const HIDDEN_B_URL = 'https://www.psacard.com/cert/01234567';
const HIDDEN_A_URL = 'https://www.psacard.com/cert/108114622';
/**
 * geometry: what a browser reports at 1280x861 (the e2e page viewport) -- checkVisibility({checkOpacity,
 * checkVisibilityCSS}), visible fraction of B in the viewport, and the element hit at the centre of B's visible part.
 * asserted:false = residual techniques the probe does not model; e2e logs them only. Since SEC-20 (S9) every listed variant is asserted.
 */
const HIDDEN_VARIANTS = Object.freeze({
  none: { how: 'control: B visible', geometry: { cssVisible: true, visibleFraction: 1, hit: 'img-slab-b' }, expected: { status: 'auto-open', url: HIDDEN_B_URL, discovered: ['img-slab-b'], tabsOpened: 1 }, asserted: true },
  opacity0: { how: 'opacity:0 on B', geometry: { cssVisible: false, visibleFraction: 1, hit: 'img-slab-b' }, expected: { status: 'none', reason: 'no slab-sized photo', mustNotAutoOpen: true, discovered: [], tabsOpened: 0 }, asserted: true },
  visibility: { how: 'visibility:hidden on B', geometry: { cssVisible: false, visibleFraction: 1, hit: 'spot-b' }, expected: { status: 'none', reason: 'no slab-sized photo', mustNotAutoOpen: true, discovered: [], tabsOpened: 0 }, asserted: true },
  offscreen: { how: 'B positioned at left:-5000px', geometry: { cssVisible: true, visibleFraction: 0, hit: null }, expected: { status: 'page-results', listed: ['01234567'], mustNotAutoOpen: true, discovered: ['img-slab-b'], tabsOpened: 0 }, asserted: true },
  overlay: { how: 'opaque <div> covers B', geometry: { cssVisible: true, visibleFraction: 1, hit: 'cover-b' }, expected: { status: 'page-results', listed: ['01234567'], mustNotAutoOpen: true, discovered: ['img-slab-b'], tabsOpened: 0 }, asserted: true },
  faint: { how: 'opacity:0.05 on B', geometry: { cssVisible: true, visibleFraction: 1, hit: 'img-slab-b' }, expected: { status: 'page-results', listed: ['01234567'], mustNotAutoOpen: true, discovered: ['img-slab-b'], tabsOpened: 0 }, asserted: true },
  'filter-opacity': { how: 'filter:opacity(0) on B', geometry: { cssVisible: true, visibleFraction: 1, hit: 'img-slab-b' }, expected: { accept: ['page-results', 'none'], mustNotAutoOpen: true, discovered: ['img-slab-b'], tabsOpened: 0 }, asserted: true },
  'overlay-pe-none': { how: 'opaque <div> with pointer-events:none covers B', geometry: { cssVisible: true, visibleFraction: 1, hit: 'img-slab-b' }, expected: { accept: ['page-results', 'none'], mustNotAutoOpen: true, discovered: ['img-slab-b'], tabsOpened: 0 }, asserted: true },
  'clip-path': { how: 'clip-path:inset(0 0 100% 0) on B', geometry: { cssVisible: true, visibleFraction: 1, hit: 'spot-b' }, expected: { accept: ['page-results', 'none'], mustNotAutoOpen: true, discovered: ['img-slab-b'], tabsOpened: 0 }, asserted: true },
  'clipped-parent': { how: 'B inside a 0 px tall overflow:hidden box', geometry: { cssVisible: true, visibleFraction: 1, hit: 'row' }, expected: { accept: ['page-results', 'none'], mustNotAutoOpen: true, discovered: ['img-slab-b'], tabsOpened: 0 }, asserted: true },
});

function hiddenHtml(sizes) {
  const disp = (file, width) => ({ width, height: Math.round((sizes[file].height * width) / sizes[file].width) });
  const a = disp(HIDDEN_A, 400);
  const b = disp(HIDDEN_B, 300);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hostile page: hidden slab image (synthetic, SEC-13)</title>
<style>
  body{margin:0;padding:16px 24px;font-family:"Liberation Sans",Arial,sans-serif;background:#fff;color:#222}
  h1{font-size:16px;margin:0 0 12px}
  .row{display:flex;gap:32px;align-items:flex-start}
  #bg-slab-a{width:${a.width}px;height:${a.height}px;background:#eee url("../${HIDDEN_A}") center/contain no-repeat}
  #spot-b{position:relative;width:${b.width}px;height:${b.height}px}
  #img-slab-b{display:block}
  #cover-b{position:absolute;inset:0;background:#f2f2f2;display:flex;align-items:center;justify-content:center;font-size:18px;color:#555}
  #cover-b[hidden]{display:none}
</style>
</head>
<body>
<h1>Hostile test page: the slab you see is a CSS background; another slab photo is hidden (SEC-13)</h1>
<div class="row" id="row">
  <div id="bg-slab-a" role="img" aria-label="Synthetic PSA-style slab shown as a CSS background (slab A)" data-fixture="${HIDDEN_A}"></div>
  <div id="spot-b">
    <img id="img-slab-b" data-fixture="${HIDDEN_B}" src="../${HIDDEN_B}" width="${b.width}" height="${b.height}" alt="Synthetic PSA-style slab (slab B)">
    <div id="cover-b" hidden>Photo unavailable</div>
  </div>
</div>
<script>
(async () => {
  // ?hide=<variant> hides slab B's <img> (see manifest.pages[kind=hostile-hidden-image].variants); default "none" is the
  // control (B visible). <html data-hide="<variant>" data-ready="1"> once slab A's background and slab B have decoded.
  const mode = new URLSearchParams(location.search).get('hide') || 'none';
  const img = document.getElementById('img-slab-b');
  const spot = document.getElementById('spot-b');
  const cover = document.getElementById('cover-b');
  const variants = {
    none: () => {},
    opacity0: () => { img.style.opacity = '0'; },
    visibility: () => { img.style.visibility = 'hidden'; },
    offscreen: () => { spot.style.position = 'absolute'; spot.style.left = '-5000px'; spot.style.top = '0'; },
    overlay: () => { cover.hidden = false; },
    faint: () => { img.style.opacity = '0.05'; },
    'filter-opacity': () => { img.style.filter = 'opacity(0)'; },
    'overlay-pe-none': () => { cover.hidden = false; cover.style.pointerEvents = 'none'; },
    'clip-path': () => { img.style.clipPath = 'inset(0 0 100% 0)'; },
    'clipped-parent': () => { spot.style.height = '0'; spot.style.overflow = 'hidden'; },
  };
  const apply = Object.prototype.hasOwnProperty.call(variants, mode) ? variants[mode] : variants.none;
  apply();
  document.documentElement.dataset.hide = Object.prototype.hasOwnProperty.call(variants, mode) ? mode : 'none';
  const bg = new Image();
  bg.src = '../${HIDDEN_A}';
  await Promise.all([img.decode().catch(() => {}), bg.decode().catch(() => {})]);
  document.documentElement.dataset.ready = '1';
})();
</script>
</body>
</html>
`;
}

function hiddenManifestEntry(sizes) {
  const disp = (file, width) => ({ width, height: Math.round((sizes[file].height * width) / sizes[file].width) });
  return {
    page: 'pages/hidden.html', elementId: 'img-slab-b', kind: 'hostile-hidden-image', finding: 'SEC-13', fixture: HIDDEN_B,
    contextMenu: 'image', display: disp(HIDDEN_B, 300),
    background: { elementId: 'bg-slab-a', fixture: HIDDEN_A, display: disp(HIDDEN_A, 400), url: HIDDEN_A_URL },
    params: { hide: `one of ${Object.keys(HIDDEN_VARIANTS).join(', ')} (default none = control)` },
    viewport: { width: 1280, height: 861 },
    variants: HIDDEN_VARIANTS,
    mustNeverOpenUrls: [HIDDEN_A_URL],
    notes: 'SEC-13 hostile page: slab A (psa-9digit, 108114622) is painted as a CSS background (never discovered by design); slab B (psa-8digit-leading-zero, 01234567) is the only <img>. In every hiding variant a page scan must not auto-open B (results list or none); slab A can never be read. All variants are asserted since the SEC-20 fix (filter/clip/mask/blend styling, five-point hit test incl. pointer-events:none covers, displayed-image-first auto-open).',
  };
}

// ---------------------------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------------------------
async function generate(outDir, browser) {
  await mkdir(path.join(outDir, 'pages'), { recursive: true });
  const codes = await makeBarcodes();
  const specs = fixtureSpecs(codes);
  const ctx = await newContext(browser);
  const pg = await ctx.newPage();
  const fontOk = await assertFontAvailable(pg);

  const buffers = {};
  const labelBoxes = {};
  for (const spec of specs) {
    let buf;
    if (spec.html) {
      const r = await renderSlab(pg, spec.html);
      buf = r.png;
      labelBoxes[spec.file] = r.labelBox;
    } else {
      buf = await deriveImage(pg, buffers[spec.from], spec.transform);
      const src = labelBoxes[spec.from];
      const k = spec.transform.type === 'downscale' ? spec.transform.width / imageSize(buffers[spec.from]).width : null;
      // Downscaled: scale the box. Rotated: no axis-aligned box (null).
      labelBoxes[spec.file] = src && k ? Object.fromEntries(Object.entries(src).map(([key, v]) => [key, Math.round(v * k)])) : null;
    }
    buffers[spec.file] = buf;
    await writeFile(path.join(outDir, spec.file), buf);
    console.log(`wrote ${spec.file}`);
  }
  await ctx.close();

  const sizes = Object.fromEntries(Object.entries(buffers).map(([f, b]) => [f, imageSize(b)]));
  const entries = pageEntries(sizes);
  const gallery = galleryHtml(entries, buffers['psa-lowres.jpg'], sizes);
  await writeFile(path.join(outDir, 'pages', 'gallery.html'), gallery);
  await writeFile(path.join(outDir, 'pages', 'frame.html'), frameHtml(entries.find((e) => e.elementId === 'img-in-frame')));
  await writeFile(path.join(outDir, 'pages', 'busy.html'), busyHtml());
  await mkdir(path.join(outDir, 'security'), { recursive: true });
  const security = [];
  for (const f of SECURITY_FIXTURES) {
    const buf = f.make();
    await writeFile(path.join(outDir, f.file), buf);
    const { make, ...rest } = f;
    security.push({ ...rest, bytes: buf.length, sha256: sha256(buf) });
  }
  console.log('wrote pages/busy.html, security/*');
  console.log('wrote pages/gallery.html, pages/frame.html');

  // A9 single-slab listing and its non-slab images.
  await mkdir(path.join(outDir, 'pages', 'assets'), { recursive: true });
  const actx = await newContext(browser);
  const apg = await actx.newPage();
  const pageAssets = [];
  for (const spec of listingAssetSpecs()) {
    const buf = await renderAsset(apg, spec.html);
    await writeFile(path.join(outDir, spec.file), buf);
    const { width, height, type } = imageSize(buf);
    const { html, ...rest } = spec;
    pageAssets.push({ ...rest, mimeType: type, width, height, bytes: buf.length, sha256: sha256(buf) });
    console.log(`wrote ${spec.file}`);
  }
  await actx.close();
  await writeFile(path.join(outDir, 'pages', 'listing.html'), listingHtml(sizes));
  console.log('wrote pages/listing.html');
  await writeFile(path.join(outDir, 'pages', 'hidden.html'), hiddenHtml(sizes));
  console.log('wrote pages/hidden.html');

  const pkg = (name) => JSON.parse(readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
  const manifest = {
    schemaVersion: 1,
    generator: 'scripts/gen-fixtures.mjs',
    synthetic: true,
    notice: 'All images are synthetic HTML/CSS renders. Grader names appear only as plain printed text; no logos, trademark artwork or real card/comic images. Cert numbers are test values (some match publicly indexed formats); e2e tests must intercept navigations to grader hosts instead of loading live pages.',
    environment: {
      chromium: browser.version(),
      playwright: pkg('playwright'),
      bwipJs: pkg('bwip-js'),
      labelFont: LABEL_FONT,
      labelFontInstalled: fontOk,
      deviceScaleFactor: 1,
    },
    evaluation: EVALUATION_RULE,
    statusLegend: {
      'auto-open': 'single high-confidence candidate with a known grader; official page opens automatically (when the setting allows)',
      confirm: 'candidate(s) shown, user must confirm/choose grader; no automatic tab',
      none: 'no usable certification number; no tab',
    },
    fixtures: specs.map((s) => {
      const b = buffers[s.file];
      const { width, height, type } = sizes[s.file];
      return {
        file: s.file,
        description: s.description,
        expected: s.expected,
        ...(s.accept ? { accept: s.accept } : {}),
        tags: s.tags,
        ...(s.notes ? { notes: s.notes } : {}),
        ...(s.graderUnresolved ? { graderUnresolved: true } : {}),
        ...(s.mustNotAutoOpen ? { mustNotAutoOpen: true } : {}),
        ...(s.mustNotOpen ? { mustNotOpen: s.mustNotOpen, mustNotOpenHosts: s.mustNotOpenHosts } : {}),
        ...(s.expectWarning ? { expectWarning: s.expectWarning } : {}),
        labelText: s.labelText,
        labelBox: labelBoxes[s.file],
        barcode: s.barcode,
        ...(s.from ? { derivedFrom: s.from, transform: s.transform } : {}),
        mimeType: type,
        width,
        height,
        bytes: b.length,
        sha256: sha256(b),
      };
    }),
    pages: entries.map((e) => ({ page: e.framePage ?? 'pages/gallery.html', ...(e.framePage ? { parentPage: 'pages/gallery.html' } : {}), ...e })),
    labelBoxNotes: 'labelBox = axis-aligned label band in natural image pixels ({x,y,width,height}); null for non-slab and rotated images.',
    pagesNotes: 'Serve tests/fixtures (or the repository root) over http; pages use relative URLs (../<fixture>). Element ids are stable. gallery.html sets <html data-ready="1"> after the blob: image loads. Append ?frameOrigin=http://localhost:<port> when the gallery is served from 127.0.0.1 to add a cross-origin iframe (#frame-cross-origin) containing #img-in-frame.',
  };
  for (const p of manifest.pages) delete p.framePage;
  manifest.pages.push({
    page: 'pages/busy.html', elementId: 'img-busy', kind: 'hostile-busy-loop', finding: 'SEC-03', fixture: 'psa-8digit-leading-zero.png',
    contextMenu: 'image', display: { width: 400, height: Math.round((sizes['psa-8digit-leading-zero.png'].height * 400) / sizes['psa-8digit-leading-zero.png'].width) },
    params: { img: 'http(s) image URL (default ../psa-8digit-leading-zero.png)', delay: 'ms after decode before blocking (default 500)', ms: 'blocking duration (default 30000, max 120000)' },
    expected: { status: 'error', error: 'timeout', maxSettleMs: 12500, cancelSettleMs: 1000 },
    notes: 'Blocks its main thread with a busy loop after the image renders (html[data-ready="1"], then data-busy="1"). Serve it on a different site than other test pages (e.g. localhost vs 127.0.0.1) so the hang stays in its own renderer. The image must not be fetchable by the extension (e.g. a hotlink-protected URL) so acquisition has to inject the page probe.',
  });
  manifest.pages.push(listingManifestEntry(sizes, pageAssets));
  manifest.pages.push(hiddenManifestEntry(sizes));
  manifest.securityFixtures = security;
  manifest.pageAssets = pageAssets;
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('wrote manifest.json');
  return manifest.environment;
}

// ---------------------------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------------------------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html; charset=utf-8', '.json': 'application/json',
  '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm' };

function startServer(outDir) {
  const routes = { '/__zxing/index.js': ZXING_IIFE, '/__zxing/zxing_reader.wasm': ZXING_WASM };
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      let file = routes[pathname];
      if (pathname === '/__verify.html') {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end('<!doctype html><meta charset="utf-8"><title>verify</title><script src="/__zxing/index.js"></script>');
        return;
      }
      if (!file && pathname.startsWith('/fixtures/')) {
        const rel = decodeURIComponent(pathname.slice('/fixtures/'.length));
        const resolved = path.resolve(outDir, rel);
        if (resolved.startsWith(outDir + path.sep)) file = resolved;
      }
      if (!file) { res.writeHead(404).end('not found'); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function verify(outDir, browser) {
  const failures = [];
  const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
  const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  console.log(`\nVerify ${outDir}`);
  console.log(`  browser: Chromium ${browser.version()}  (manifest generated with ${manifest.environment.chromium})`);

  for (const f of manifest.securityFixtures ?? []) {
    const buf = await readFile(path.join(outDir, f.file));
    if (sha256(buf) !== f.sha256 || buf.length !== f.bytes) fail(`${f.file}: bytes/sha256 differ from manifest`);
    if (f.file.endsWith('.bmp') && (buf.toString('ascii', 0, 2) !== 'BM' || buf.readInt32LE(18) !== f.declared.width || buf.readInt32LE(22) !== f.declared.height)) fail(`${f.file}: BMP header mismatch`);
    if (f.file.endsWith('.jpg')) {
      const s = f.structure;
      const at = s.sofOffset;
      if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[at] !== 0xff || buf[at + 1] !== 0xc0) fail(`${f.file}: SOI/SOF0 not where declared`);
      else if (buf.readUInt16BE(at + 5) !== f.declared.height || buf.readUInt16BE(at + 7) !== f.declared.width) fail(`${f.file}: SOF0 size mismatch`);
      if (!(at > s.headBytes)) fail(`${f.file}: SOF0 at ${at} is inside the first ${s.headBytes} bytes`);
      if (!(buf.length < s.unknownSizeLimitBytes)) fail(`${f.file}: ${buf.length} bytes, not below the ${s.unknownSizeLimitBytes}-byte unknown-size limit`);
      // Segment walk from SOI: no SOFn before the declared offset.
      let i = 2;
      while (i < at) {
        const m = buf[i + 1];
        if (buf[i] !== 0xff || (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m))) { fail(`${f.file}: unexpected marker at ${i}`); break; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      if (i !== at) fail(`${f.file}: segment walk reaches ${i}, not the SOF0 at ${at}`);
    }
    if (f.file.endsWith('.gif')) {
      const s = f.structure;
      if (buf.toString('ascii', 0, 6) !== 'GIF89a' || buf.readUInt16LE(6) !== s.screen.width || buf.readUInt16LE(8) !== s.screen.height) fail(`${f.file}: GIF screen mismatch`);
      const d = buf.indexOf(0x2c, 13 + 6 + 8);
      if (d < 0 || buf.readUInt16LE(d + 5) !== s.frame.width || buf.readUInt16LE(d + 7) !== s.frame.height) fail(`${f.file}: GIF frame mismatch`);
    }
  }
  // 1. Static: size budget, hash and header dimensions match the manifest.
  for (const f of manifest.fixtures) {
    const buf = await readFile(path.join(outDir, f.file));
    const dim = imageSize(buf);
    if (buf.length >= MAX_BYTES) fail(`${f.file}: ${buf.length} bytes >= ${MAX_BYTES}`);
    if (sha256(buf) !== f.sha256) fail(`${f.file}: sha256 differs from manifest`);
    if (dim.width !== f.width || dim.height !== f.height) fail(`${f.file}: header ${dim.width}x${dim.height} != manifest`);
    if (dim.type !== f.mimeType) fail(`${f.file}: type ${dim.type} != ${f.mimeType}`);
  }

  const server = await startServer(outDir);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const ctx = await newContext(browser, { width: 1280, height: 800 });
  try {
    // 2. Browser decode + zxing-wasm decode at natural size.
    const pg = await ctx.newPage();
    const external = [];
    const local = [base, `http://localhost:${port}`, 'data:', 'blob:'];
    pg.on('request', (r) => { if (!local.some((p) => r.url().startsWith(p))) external.push(r.url()); });
    await pg.goto(`${base}/__verify.html`);
    const defaults = await pg.evaluate(async () => {
      await ZXingWASM.prepareZXingModule({
        overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? `/__zxing/${p}` : prefix + p) },
        fireImmediately: true,
      });
      return ZXingWASM.defaultReaderOptions;
    });
    console.log(`  zxing-wasm reader ready (default tryHarder=${defaults.tryHarder}, binarizer=${defaults.binarizer})`);
    // A = whole image, zxing default options (tryHarder etc.)         -> required for barcode fixtures
    // B = whole image, fast mode (only ~15 rows around the centre)      -> informational
    // C = labelBox crop (ImageData), fast mode, no rotate/invert/scale  -> required for barcode fixtures
    console.log('  file                          natural    bytes   A: full image, default (tryHarder) | B: full image, fast | C: label crop, fast');
    for (const f of manifest.fixtures) {
      const r = await pg.evaluate(async ({ file, box }) => {
        const url = `/fixtures/${file}`;
        const img = new Image();
        img.src = url;
        await img.decode();
        const blob = await (await fetch(url)).blob();
        const pick = (rs) => rs.filter((x) => x.isValid).map((x) => ({
          format: x.format, text: x.text,
          widthPx: Math.round(Math.hypot(x.position.topRight.x - x.position.topLeft.x, x.position.topRight.y - x.position.topLeft.y)),
        }));
        const fastOpts = { tryHarder: false, tryRotate: false, tryInvert: false, tryDownscale: false, maxNumberOfSymbols: 8 };
        const full = pick(await ZXingWASM.readBarcodes(blob, { maxNumberOfSymbols: 8 }));
        const fast = pick(await ZXingWASM.readBarcodes(blob, fastOpts));
        let crop = null;
        if (box) {
          const c = document.createElement('canvas');
          c.width = box.width;
          c.height = box.height;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
          crop = pick(await ZXingWASM.readBarcodes(ctx.getImageData(0, 0, box.width, box.height), fastOpts));
        }
        return { w: img.naturalWidth, h: img.naturalHeight, full, fast, crop };
      }, { file: f.file, box: f.labelBox });
      const fmt = (rs) => (rs === null ? 'n/a' : rs.length ? rs.map((x) => `${x.format}:"${x.text}" (~${x.widthPx}px)`).join(', ') : '-');
      console.log(`  ${f.file.padEnd(29)} ${`${r.w}x${r.h}`.padEnd(10)} ${String(f.bytes).padStart(6)}   A ${fmt(r.full)} | B ${fmt(r.fast)} | C ${fmt(r.crop)}`);
      if (r.w !== f.width || r.h !== f.height) fail(`${f.file}: browser decoded ${r.w}x${r.h}, manifest ${f.width}x${f.height}`);
      if (r.w < 200 || r.h < 150 || r.w > 1600 || r.h > 1600) fail(`${f.file}: dimensions ${r.w}x${r.h} outside sane range`);
      const required = f.barcode ? [['A', r.full], ['C', r.crop]] : [['A', r.full], ['B', r.fast], ['C', r.crop ?? []]];
      for (const [mode, rs] of required) {
        if (f.barcode) {
          if (!rs || rs.length !== 1 || rs[0].format !== f.barcode.format || rs[0].text !== f.barcode.text) {
            fail(`${f.file}: decode ${mode} expected exactly ${f.barcode.format} "${f.barcode.text}", got ${fmt(rs)}`);
          }
        } else if (rs.length) {
          fail(`${f.file}: decode ${mode} found unexpected symbol(s) ${fmt(rs)}`);
        }
      }
    }

    // 3. Gallery page loads every element as described in manifest.pages.
    await pg.goto(`${base}/fixtures/pages/gallery.html?frameOrigin=${encodeURIComponent(`http://localhost:${port}`)}`);
    await pg.waitForSelector('html[data-ready="1"]', { timeout: 10000 });
    const before = await pg.evaluate(() => {
      const lazy = document.getElementById('img-lazy');
      return { lazyLoadedEarly: lazy.complete && lazy.naturalWidth > 0, srcsetCurrent: document.getElementById('img-srcset').currentSrc };
    });
    await pg.locator('#img-lazy').scrollIntoViewIfNeeded();
    await pg.waitForFunction(() => document.getElementById('img-lazy').naturalWidth > 0, null, { timeout: 10000 });
    const state = {};
    for (const p of manifest.pages.filter((x) => x.page === 'pages/gallery.html')) {
      const loc = pg.locator(`#${p.elementId}`);
      if (await loc.count()) await loc.scrollIntoViewIfNeeded();
      state[p.elementId] = await pg.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          fixture: el.dataset.fixture, natural: el.naturalWidth ?? null,
          src: el.currentSrc || el.src || getComputedStyle(el).backgroundImage, hitId: hit ? hit.id : null,
        };
      }, p.elementId);
    }
    for (const p of manifest.pages.filter((x) => x.page === 'pages/gallery.html')) {
      const s = state[p.elementId];
      if (!s) { fail(`gallery: #${p.elementId} missing`); continue; }
      if (s.fixture !== p.fixture) fail(`gallery: #${p.elementId} data-fixture ${s.fixture} != ${p.fixture}`);
      if (p.kind === 'css-background') {
        const ok = await pg.evaluate(async (bg) => {
          const m = /url\("?(.*?)"?\)/.exec(bg);
          if (!m) return false;
          const im = new Image(); im.src = m[1]; await im.decode(); return im.naturalWidth > 0;
        }, s.src);
        if (!ok) fail(`gallery: #${p.elementId} background image did not load`);
      } else if (!(s.natural > 0)) fail(`gallery: #${p.elementId} not loaded`);
      if (p.kind === 'img-under-overlay' && s.hitId !== p.overlayId) fail(`gallery: overlay does not cover #${p.elementId} (hit ${s.hitId})`);
      if (p.kind !== 'img-under-overlay' && s.hitId !== p.elementId) fail(`gallery: #${p.elementId} not the hit target at its centre (hit ${s.hitId})`);
    }
    const frames = {};
    for (const fr of pg.frames()) {
      if (fr === pg.mainFrame()) continue;
      const el = await fr.frameElement();
      const id = await el.getAttribute('id');
      frames[id] = { origin: new URL(fr.url()).origin, natural: await fr.evaluate(() => document.getElementById('img-in-frame')?.naturalWidth ?? 0) };
    }
    const inFrame = manifest.pages.find((p) => p.elementId === 'img-in-frame');
    for (const id of [inFrame.frameId, 'frame-cross-origin']) {
      if (!frames[id] || !(frames[id].natural > 0)) fail(`gallery: #img-in-frame not loaded inside #${id}`);
    }
    if (frames['frame-cross-origin'] && frames['frame-cross-origin'].origin === base) fail('gallery: cross-origin frame is same-origin');
    console.log(`  gallery: ${Object.keys(state).length} main-document elements loaded; lazy image loaded before scroll: ${before.lazyLoadedEarly}; ` +
      `srcset currentSrc: ${before.srcsetCurrent.replace(base, '')}; frames: ${Object.entries(frames).map(([k, v]) => `${k}@${v.origin.replace(/:\d+$/, ':<port>')} img ${v.natural}px`).join(', ')}; ` +
      `overlay hit-test: #${state['img-under-overlay'].hitId}`);
    if (before.lazyLoadedEarly) fail('gallery: #img-lazy loaded before scrolling (spacer too short)');

    // 4. A9 listing: assets match the manifest; each variant shows exactly the images it declares as discoverable
    //    (A9 thresholds); the slab is fully visible in the e2e viewport; the page text holds the non-cert numbers.
    for (const a of manifest.pageAssets ?? []) {
      const buf = await readFile(path.join(outDir, a.file));
      const dim = imageSize(buf);
      if (sha256(buf) !== a.sha256 || buf.length !== a.bytes) fail(`${a.file}: bytes/sha256 differ from manifest`);
      if (dim.width !== a.width || dim.height !== a.height) fail(`${a.file}: header ${dim.width}x${dim.height} != manifest`);
    }
    const listing = manifest.pages.find((p) => p.kind === 'single-slab-listing');
    if (!listing) fail('listing: pages/listing.html missing from manifest.pages');
    else {
      const lctx = await newContext(browser, { width: 1280, height: 1000 });
      try {
        const lpg = await lctx.newPage();
        lpg.on('request', (r) => { if (!local.some((p) => r.url().startsWith(p))) external.push(r.url()); });
        for (const [variant, exp] of Object.entries(listing.expected)) {
          await lpg.goto(`${base}/fixtures/${listing.page}${variant === 'default' ? '' : `?${variant}`}`);
          await lpg.waitForSelector('html[data-ready="1"]', { timeout: 10000 });
          const seen = await lpg.evaluate(({ minR, minN }) => [...document.images].filter((im) => im.getAttribute('src')).map((im) => {
            const r = im.getBoundingClientRect();
            const ix = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
            const iy = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
            return {
              id: im.id, natural: { width: im.naturalWidth, height: im.naturalHeight }, rendered: { width: Math.round(r.width), height: Math.round(r.height) },
              discoverable: im.complete && im.naturalWidth > 0 && Math.min(im.naturalWidth, im.naturalHeight) >= minN && Math.min(r.width, r.height) >= minR,
              visible: r.width && r.height ? (ix * iy) / (r.width * r.height) : 0,
            };
          }), { minR: A9_MIN_RENDERED, minN: A9_MIN_NATURAL });
          const disc = seen.filter((s) => s.discoverable).map((s) => s.id).sort();
          if (JSON.stringify(disc) !== JSON.stringify([...exp.discovered].sort())) fail(`listing ${variant}: discoverable ${disc.join(',')} != ${exp.discovered.join(',')}`);
          for (const s of seen) {
            const m = listing.images.find((i) => i.elementId === s.id);
            if (!m) { fail(`listing ${variant}: undeclared image #${s.id}`); continue; }
            if (s.natural.width !== m.natural.width || s.natural.height !== m.natural.height) fail(`listing: #${s.id} natural ${s.natural.width}x${s.natural.height} != manifest`);
            if (s.rendered.width !== m.display.width || s.rendered.height !== m.display.height) fail(`listing: #${s.id} rendered ${s.rendered.width}x${s.rendered.height} != manifest`);
            if (s.discoverable !== m.discoverable) fail(`listing: #${s.id} discoverable ${s.discoverable} != manifest`);
          }
          if (variant === 'default') {
            const slab = seen.find((s) => s.id === listing.elementId);
            if (!slab || slab.visible < 1) fail(`listing: slab photo not fully visible at 1280x1000 (${slab?.visible})`);
            const text = await lpg.evaluate(() => document.body.innerText);
            for (const v of Object.values(listing.textNumbers)) if (!text.includes(v)) fail(`listing: page text lacks "${v}"`);
          }
          console.log(`  listing${variant === 'default' ? '' : `?${variant}`}: discoverable ${disc.join(', ') || '(none)'}; ${seen.length} images loaded`);
        }
      } finally {
        await lctx.close();
      }
    }
    // 5. SEC-13 hostile page: in each variant slab A's background loads and slab B's <img> loads, and the browser
    //    reports the declared geometry (CSS visibility, visible fraction, element hit at the centre of B).
    const hidden = manifest.pages.find((p) => p.kind === 'hostile-hidden-image');
    if (!hidden) fail('hidden: pages/hidden.html missing from manifest.pages');
    else {
      const hctx = await newContext(browser, hidden.viewport);
      try {
        const hpg = await hctx.newPage();
        hpg.on('request', (r) => { if (!local.some((p) => r.url().startsWith(p))) external.push(r.url()); });
        for (const [variant, spec] of Object.entries(hidden.variants)) {
          await hpg.goto(`${base}/fixtures/${hidden.page}?hide=${encodeURIComponent(variant)}`);
          await hpg.waitForSelector('html[data-ready="1"]', { timeout: 10000 });
          const g = await hpg.evaluate(async () => {
            const img = document.getElementById('img-slab-b');
            const bgUrl = /url\("?(.*?)"?\)/.exec(getComputedStyle(document.getElementById('bg-slab-a')).backgroundImage)?.[1];
            const bg = new Image();
            bg.src = bgUrl;
            await bg.decode().catch(() => {});
            const r = img.getBoundingClientRect();
            const x0 = Math.max(r.left, 0); const y0 = Math.max(r.top, 0);
            const x1 = Math.min(r.right, innerWidth); const y1 = Math.min(r.bottom, innerHeight);
            const vf = x1 > x0 && y1 > y0 ? Math.round((((x1 - x0) * (y1 - y0)) / (r.width * r.height)) * 100) / 100 : 0;
            const hit = vf > 0 ? document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2) : null;
            return {
              mode: document.documentElement.dataset.hide, bgNatural: bg.naturalWidth, natural: img.naturalWidth,
              cssVisible: img.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }), visibleFraction: vf,
              hit: hit ? (hit.id || hit.tagName.toLowerCase()) : null, rendered: { width: Math.round(r.width), height: Math.round(r.height) },
            };
          });
          const want = spec.geometry;
          if (g.mode !== variant) fail(`hidden ${variant}: page applied "${g.mode}"`);
          if (!(g.bgNatural > 0) || !(g.natural > 0)) fail(`hidden ${variant}: slab A background or slab B not loaded`);
          if (g.rendered.width !== hidden.display.width || g.rendered.height !== hidden.display.height) fail(`hidden ${variant}: B rendered ${g.rendered.width}x${g.rendered.height}`);
          if (g.cssVisible !== want.cssVisible || g.visibleFraction !== want.visibleFraction || g.hit !== want.hit) {
            fail(`hidden ${variant}: geometry ${JSON.stringify({ cssVisible: g.cssVisible, visibleFraction: g.visibleFraction, hit: g.hit })} != ${JSON.stringify(want)}`);
          }
          console.log(`  hidden?hide=${variant}: cssVisible ${g.cssVisible}, visible ${g.visibleFraction}, hit #${g.hit}`);
        }
      } finally {
        await hctx.close();
      }
    }
    if (external.length) fail(`unexpected non-local requests: ${external.join(', ')}`);
  } finally {
    await ctx.close();
    server.close();
  }
  console.log(failures.length ? `\nVERIFY FAILED (${failures.length})` : '\nVERIFY OK');
  return failures.length === 0;
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const browser = await launchBrowser();
  let ok = true;
  try {
    if (opts.generate) {
      const env = await generate(opts.out, browser);
      if (opts.bench) await generateBench(opts.out, browser, env);
    }
    if (opts.verify) {
      ok = await verify(opts.out, browser);
      if (opts.bench) ok = (await verifyBench(opts.out, browser)) && ok;
    }
  } finally {
    await browser.close();
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
