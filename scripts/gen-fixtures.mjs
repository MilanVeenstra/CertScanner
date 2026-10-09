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
 * Usage:
 *   node scripts/gen-fixtures.mjs                 generate into tests/fixtures, then verify
 *   node scripts/gen-fixtures.mjs --verify-only   verify the existing fixtures only
 *   node scripts/gen-fixtures.mjs --no-verify     generate without verifying
 *   node scripts/gen-fixtures.mjs --out <dir>     write somewhere else (e.g. byte-stability check)
 *
 * Env: CERTSCANNER_CHROMIUM=<path to chrome>  (default: /opt/pw-browsers/chromium-1194/chrome-linux/chrome
 *      if present, otherwise Playwright's own bundled Chromium).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, generate: true, verify: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify-only') opts.generate = false;
    else if (a === '--no-verify') opts.verify = false;
    else if (a === '--out') opts.out = path.resolve(argv[++i] ?? '');
    else if (a.startsWith('--out=')) opts.out = path.resolve(a.slice(6));
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/gen-fixtures.mjs [--out <dir>] [--verify-only | --no-verify]');
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
      expected: { status: 'none', grader: null, number: null },
      mustNotOpen: [FOREIGN_QR_URL],
      mustNotOpenHosts: ['evil.example'],
      notes: 'Security negative: the decoded URL must never be opened and its embedded number must not become an auto-open candidate. A warning about an unrecognised QR is expected.',
      tags: ['qr', 'negative', 'security', 'foreign-host'],
      labelText: ['SCAN TO VERIFY'],
      barcode: { format: 'QRCode', text: FOREIGN_QR_URL, modulePx: 4, quietZonePx: 16 },
    },
    {
      file: 'ambiguous-10digit.png',
      html: page(cardSlab(plainLabel('5012345678'), cardFront({ frame: '#9fb8ad', art1: '#d9ead3', art2: '#5f8575', panel: '#e3ece7' }))),
      description: 'Plain white label containing only the 10-digit number 5012345678; no grader words, so the grader cannot be decided.',
      expected: { status: 'confirm', grader: null, number: '5012345678' },
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
  console.log('wrote pages/gallery.html, pages/frame.html');

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
    evaluation: 'A run passes a fixture when the observed status is in (accept ?? [expected.status]); when expected.number is non-null the top candidate must equal it exactly (string compare, leading zeros kept); when expected.grader is non-null the routed grader must equal it, when null no grader may be auto-selected; mustNotOpen URLs/hosts must never be navigated to.',
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
        ...(s.mustNotOpen ? { mustNotOpen: s.mustNotOpen, mustNotOpenHosts: s.mustNotOpenHosts } : {}),
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
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('wrote manifest.json');
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
    if (opts.generate) await generate(opts.out, browser);
    if (opts.verify) ok = await verify(opts.out, browser);
  } finally {
    await browser.close();
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
