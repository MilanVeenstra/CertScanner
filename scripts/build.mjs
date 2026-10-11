#!/usr/bin/env node
/**
 * CertScanner build (ADR-001 §12, §14). No bundler: copies src/ plus the pinned vendor files.
 *
 *   node scripts/build.mjs           -> dist/      (release layout; load unpacked or zip)
 *   node scripts/build.mjs --e2e     -> dist-e2e/  (dist + e2e-harness/ from tests/e2e/harness/ + host_permissions ["<all_urls>"])
 *   node scripts/build.mjs --check   -> builds dist/ and validates it (exit 1 on any failure)
 *   node scripts/build.mjs --package -> builds + checks dist/, writes certscanner-<version>.zip from dist/ only
 *                                       (deterministic order/timestamps), re-validates the manifest inside the ZIP
 *                                       and prints its sha256. Refuses target != release or a dirty tree unless
 *                                       --allow-dirty (SEC-12); a dirty package is named certscanner-<version>-dirty.zip.
 *
 * Dirty = any modified, untracked or ignored file under src/, third_party/, scripts/build.mjs, package*.json (SEC-15).
 * Vendor files and their licences are pinned by sha256 below; any difference fails the build (SEC-15).
 * Env: SOURCE_DATE_EPOCH (seconds) sets builtAt; default: the HEAD commit time (SEC-15), else the current time.
 */
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const NM = path.join(ROOT, 'node_modules');
const args = new Set(process.argv.slice(2));
for (const a of args) if (!['--e2e', '--check', '--package', '--allow-dirty'].includes(a)) { console.error(`Unknown argument: ${a}`); process.exit(2); }
const E2E = args.has('--e2e');
const PACKAGE = args.has('--package');
const CHECK = args.has('--check') || PACKAGE;
const ALLOW_DIRTY = args.has('--allow-dirty');
if (E2E && CHECK) { console.error('--e2e cannot be combined with --check/--package (they validate the release dist/)'); process.exit(2); }
const OUT = path.join(ROOT, E2E ? 'dist-e2e' : 'dist');

/** Executable/data files shipped from node_modules (ADR §12), pinned by sha256 (SEC-15). */
const VENDOR = [
  { pkg: 'tesseract.js', from: 'tesseract.js/dist/tesseract.min.js', to: 'vendor/tesseract/tesseract.min.js', sha256: '000c27d9cd0def655f77b36c72a389c0ab13793aa31cb4d7aab56d09c0afbc7e' },
  { pkg: 'tesseract.js', from: 'tesseract.js/dist/worker.min.js', to: 'vendor/tesseract/worker.min.js', sha256: '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d' },
  { pkg: 'tesseract.js-core', from: 'tesseract.js-core/tesseract-core-simd-lstm.js', to: 'vendor/tesseract/tesseract-core-simd-lstm.js', sha256: 'e48e2f02ddae3716c8dd24bf41cd290d4efa96892d689cdc4013c2545d63f469' },
  { pkg: 'tesseract.js-core', from: 'tesseract.js-core/tesseract-core-simd-lstm.wasm', to: 'vendor/tesseract/tesseract-core-simd-lstm.wasm', sha256: '34e8d50cac216427d86bf397d610fdd9f49492539bbcdfbfccc4eda20c810bea' },
  { pkg: '@tesseract.js-data/eng', from: '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', to: 'vendor/tesseract/lang/eng.traineddata.gz', sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91' },
  { pkg: 'zxing-wasm', from: 'zxing-wasm/dist/iife/reader/index.js', to: 'vendor/zxing/zxing-reader.iife.js', sha256: '228e6d8ccb841c544386eeafd5f18294d3e4aa0e7aa20419bc51a0009b9d3c17' },
  { pkg: 'zxing-wasm', from: 'zxing-wasm/dist/reader/zxing_reader.wasm', to: 'vendor/zxing/zxing_reader.wasm', sha256: 'aecc1876de036c62c8419f67a5e1a16b1698a325bcd190aa84810d516e263931' },
];
const LICENSES = [
  { from: 'tesseract.js/LICENSE.md', to: 'vendor/tesseract/LICENSE-tesseract.js.md', sha256: 'b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1' },
  { from: 'tesseract.js/dist/tesseract.min.js.LICENSE.txt', to: 'vendor/tesseract/tesseract.min.js.LICENSE.txt', sha256: 'cdf963ced7d25a0f98901a547647b4d6e2dbe0197fd78c87a059a87b0e542fe2' },
  { from: 'tesseract.js/dist/worker.min.js.LICENSE.txt', to: 'vendor/tesseract/worker.min.js.LICENSE.txt', sha256: '45f54171aeaa1d10c0c1a66f374b7bba1f02472b1487fbe892eec04f840002ac' },
  { from: 'tesseract.js-core/LICENSE', to: 'vendor/tesseract/LICENSE-tesseract.js-core.txt', sha256: 'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08' },
  { from: 'zxing-wasm/LICENSE', to: 'vendor/zxing/LICENSE-zxing-wasm.txt', sha256: 'fb506e4ade12d7a9efa67c9d76a9a28c8e15d347ca49a69e48e29b40b34ad2ab' },
];
/** Paths whose working-tree state decides gitDirty (SEC-15): every file that ends up in, or decides, the package. */
const DIRTY_PATHS = ['src', 'third_party', 'scripts/build.mjs', 'package.json', 'package-lock.json'];
/** Licence texts of libraries linked into the vendor WASM (SEC-05); kept in the repo, see third_party/licenses/README.md. */
const LINKED_LICENSES_DIR = path.join(ROOT, 'third_party', 'licenses');
const LINKED_LICENSES = [
  'leptonica.BSD-2-Clause.txt',
  'libjpeg-9a.IJG-legal.txt',
  'libpng-1.6.38.PNG-v2.txt',
  'libtiff.COPYRIGHT.txt',
  'zlib-1.2.12.txt',
  'giflib.COPYING.txt',
  'libwebp.COPYING.txt',
  'libwebp.PATENTS.txt',
  'openlibm.LICENSE.md',
  'zxing-cpp.Apache-2.0.txt',
  'libzueci.BSD-3-Clause.txt',
];
const EXPECTED_VERSIONS = { 'tesseract.js': '7.0.0', 'tesseract.js-core': /^7\./, '@tesseract.js-data/eng': '1.0.0', 'zxing-wasm': '3.1.5' };

/** Hosts allowed to appear as http(s) URLs anywhere in src/** (CERT_URL / QR_HOSTS only). */
const ALLOWED_URL_HOSTS = new Set([
  'www.psacard.com', 'psacard.com', 'www.cgccomics.com', 'cgccomics.com', 'www.cgccards.com', 'cgccards.com', 'www.cgccards.uk', 'cgccards.uk',
  // Price & listing links (src/core/priceLinks.js): opened only on a user click, never fetched.
  '130point.com', 'www.pricecharting.com', 'www.ebay.com', 'www.ebay.co.uk', 'www.ebay.de', 'www.ebay.nl', 'www.ebay.fr', 'www.ebay.ca', 'www.ebay.com.au',
]);
const REQUIRED_PERMISSIONS = ['contextMenus', 'activeTab', 'scripting', 'storage', 'sidePanel'];
const RELEASE_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
const TEXT_EXT = new Set(['.js', '.mjs', '.html', '.css', '.json']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

function pkgVersion(name) {
  return JSON.parse(readFileSync(path.join(NM, name, 'package.json'), 'utf8')).version;
}

function git(...a) {
  try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** Remote URL strings inside a vendor file (informational: overridden at runtime, ADR §15). */
function remoteUrlStrings(buf) {
  const text = buf.toString('latin1');
  return [...new Set(text.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)]*/gi) ?? [])]
    .filter((u) => /jsdelivr|unpkg|cdnjs|githubusercontent/i.test(u)).sort();
}

async function build() {
  for (const v of VENDOR) if (!existsSync(path.join(NM, v.from))) throw new Error(`missing ${v.from}; run npm ci`);
  // SEC-15: what ships must be byte-identical to the reviewed vendor files.
  for (const v of [...VENDOR, ...LICENSES]) {
    const got = sha256(readFileSync(path.join(NM, v.from)));
    if (got !== v.sha256) throw new Error(`vendor sha256 mismatch for node_modules/${v.from}: ${got} (pinned ${v.sha256}); run npm ci or review the update`);
  }
  for (const [name, want] of Object.entries(EXPECTED_VERSIONS)) {
    const got = pkgVersion(name);
    if (want instanceof RegExp ? !want.test(got) : got !== want) throw new Error(`${name} is ${got}, expected ${want}`);
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await cp(SRC, OUT, { recursive: true });

  const vendorInfo = [];
  for (const v of VENDOR) {
    const dest = path.join(OUT, v.to);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(NM, v.from), dest);
    const buf = await readFile(dest);
    vendorInfo.push({ name: v.pkg, version: pkgVersion(v.pkg), file: v.to, bytes: buf.length, sha256: sha256(buf), remoteUrlStrings: remoteUrlStrings(buf) });
  }
  for (const l of LICENSES) {
    const dest = path.join(OUT, l.to);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(NM, l.from), dest);
  }
  await mkdir(path.join(OUT, 'vendor', 'licenses'), { recursive: true });
  for (const f of LINKED_LICENSES) await cp(path.join(LINKED_LICENSES_DIR, f), path.join(OUT, 'vendor', 'licenses', f));
  await writeFile(path.join(OUT, 'vendor', 'THIRD_PARTY_NOTICES.txt'), notices());

  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  let harness = false;
  if (E2E) {
    manifest.host_permissions = ['<all_urls>'];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const harnessSrc = path.join(ROOT, 'tests', 'e2e', 'harness');
    if (existsSync(harnessSrc)) {
      await cp(harnessSrc, path.join(OUT, 'e2e-harness'), { recursive: true });
      harness = true;
    }
  }

  const commit = git('rev-parse', 'HEAD');
  // SEC-15: modified, untracked AND ignored files count (an ignored file under src/ would be copied into dist/).
  const dirty = commit === null ? null : git('status', '--porcelain', '--ignored', '--untracked-files=all', '--', ...DIRTY_PATHS);
  const envEpoch = Number(process.env.SOURCE_DATE_EPOCH);
  const commitEpoch = Number(commit === null ? NaN : git('log', '-1', '--format=%ct', 'HEAD'));
  const epoch = Number.isFinite(envEpoch) && envEpoch > 0 ? envEpoch : (Number.isFinite(commitEpoch) && commitEpoch > 0 ? commitEpoch : null);
  const info = {
    name: 'CertScanner',
    version: manifest.version,
    gitCommit: commit,
    gitDirty: dirty === null ? null : dirty.length > 0,
    builtAt: new Date(epoch !== null ? epoch * 1000 : Date.now()).toISOString(),
    target: E2E ? 'e2e' : 'release',
    e2eHarness: harness,
    vendor: vendorInfo,
  };
  await writeFile(path.join(OUT, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  if (dirty) info.dirtyFiles = dirty.split('\n').filter(Boolean).slice(0, 10); // for the refusal message only

  const files = await walk(OUT);
  const bytes = files.reduce((s, f) => s + statSync(f).size, 0);
  console.log(`built ${rel(OUT)}/ (${info.target}) - ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB${harness ? ', e2e-harness included' : ''}${E2E && !harness ? ' (no tests/e2e/harness yet)' : ''}`);
  return info;
}

function notices() {
  const v = (n) => pkgVersion(n);
  return `CertScanner bundles the following third-party components, unmodified, under vendor/.

tesseract.js ${v('tesseract.js')} (Apache-2.0) - vendor/tesseract/{tesseract.min.js,worker.min.js}
  License: vendor/tesseract/LICENSE-tesseract.js.md
  Bundled sub-components: vendor/tesseract/tesseract.min.js.LICENSE.txt, vendor/tesseract/worker.min.js.LICENSE.txt
tesseract.js-core ${v('tesseract.js-core')} (Apache-2.0; Emscripten build of Tesseract OCR, Apache-2.0, and Leptonica, BSD-2-Clause)
  - vendor/tesseract/tesseract-core-simd-lstm.{js,wasm}
  License: vendor/tesseract/LICENSE-tesseract.js-core.txt
@tesseract.js-data/eng ${v('@tesseract.js-data/eng')} (package: MIT) - vendor/tesseract/lang/eng.traineddata.gz
  Model: Tesseract "eng" 4.0.0_best_int traineddata from the tesseract-ocr/tessdata project (Apache-2.0).
zxing-wasm ${v('zxing-wasm')} (MIT) - vendor/zxing/{zxing-reader.iife.js,zxing_reader.wasm}
  License: vendor/zxing/LICENSE-zxing-wasm.txt
  Built from zxing-cpp (Apache-2.0) - License: vendor/licenses/zxing-cpp.Apache-2.0.txt

Libraries statically linked into vendor/tesseract/tesseract-core-simd-lstm.wasm:
  Leptonica (BSD-2-Clause) - vendor/licenses/leptonica.BSD-2-Clause.txt
  IJG libjpeg 9a (IJG license) - vendor/licenses/libjpeg-9a.IJG-legal.txt
    This software is based in part on the work of the Independent JPEG Group.
  libpng 1.6.38 (PNG Reference Library License v2) - vendor/licenses/libpng-1.6.38.PNG-v2.txt
  LibTIFF (libtiff license) - vendor/licenses/libtiff.COPYRIGHT.txt
  zlib 1.2.12 (zlib license) - vendor/licenses/zlib-1.2.12.txt
  giflib (MIT-style) - vendor/licenses/giflib.COPYING.txt
  libwebp (BSD-3-Clause + patent grant) - vendor/licenses/libwebp.COPYING.txt, vendor/licenses/libwebp.PATENTS.txt
  openlibm (various permissive) - vendor/licenses/openlibm.LICENSE.md
Libraries compiled into vendor/zxing/zxing_reader.wasm:
  libzueci, bundled in zxing-cpp (BSD-3-Clause) - vendor/licenses/libzueci.BSD-3-Clause.txt

All code, WebAssembly and model data are packaged with the extension; nothing is downloaded at runtime.
`;
}

// ------------------------------------------------------------------------------------------------
// --check
// ------------------------------------------------------------------------------------------------
/** Release-manifest rules (ADR §3 + A7/SEC-01). `has(file)` tells whether a referenced file exists. */
function manifestProblems(manifestRaw, has) {
  const out = [];
  let m;
  try { m = JSON.parse(manifestRaw); } catch { return ['manifest.json is not valid JSON']; }
  if (m.manifest_version !== 3) out.push('manifest_version must be 3');
  if ('host_permissions' in m) out.push('release manifest must not declare host_permissions');
  if (manifestRaw.includes('<all_urls>')) out.push('release manifest must not mention <all_urls>');
  for (const k of ['content_scripts', 'web_accessible_resources', 'externally_connectable']) if (k in m) out.push(`manifest must not declare ${k}`);
  const perms = [...(m.permissions ?? [])].sort();
  if (JSON.stringify(perms) !== JSON.stringify([...REQUIRED_PERMISSIONS].sort())) out.push(`permissions ${JSON.stringify(m.permissions)} != ${JSON.stringify(REQUIRED_PERMISSIONS)}`);
  if (JSON.stringify(m.optional_host_permissions) !== JSON.stringify(['https://*/*'])) out.push('optional_host_permissions must be ["https://*/*"]');
  if (m.content_security_policy?.extension_pages !== RELEASE_CSP) out.push('extension_pages CSP differs from ADR §3');
  if (m.minimum_chrome_version !== '116') out.push('minimum_chrome_version must be 116');
  if (m.incognito !== 'not_allowed') out.push('manifest must set "incognito": "not_allowed" (SEC-01: no history writes from incognito)');
  const referenced = [m.background?.service_worker, m.side_panel?.default_path, ...Object.values(m.icons ?? {})].filter(Boolean);
  for (const f of referenced) if (!has(f)) out.push(`manifest references missing file ${f}`);
  // A9: page-scan keyboard command (a manifest key, not a permission)
  const cmd = m.commands?.['scan-page'];
  if (!cmd || !/^__MSG_[a-z0-9_]+__$/.test(cmd.description ?? '') || !cmd.suggested_key?.default) out.push('manifest needs commands["scan-page"] with a suggested key and a localized description (A9)');
  return out;
}

// ------------------------------------------------------------------------------------------------
// --package (SEC-12): deterministic ZIP of dist/ only
// ------------------------------------------------------------------------------------------------
const { deflateRawSync, inflateRawSync } = zlib;
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
/** zlib.crc32 exists from Node 22.2; fallback for Node 20 (package.json engines). */
const zlibCrc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const DOS_TIME = 0;                          // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1;    // 1980-01-01

function zipFiles(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlibCrc32(data) >>> 0;
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Minimal reader for the ZIPs written above: [{name, data}] with CRC verification. */
function unzipFiles(buf) {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('ZIP end record not found');
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if ((zlibCrc32(data) >>> 0) !== crc) throw new Error(`CRC mismatch for ${name}`);
    out.push({ name, data });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

async function packageZip(info) {
  if (info.target !== 'release') throw new Error(`refusing to package target=${info.target} (release only)`);
  const dirty = info.gitDirty !== false;
  if (dirty) {
    const which = info.dirtyFiles?.length ? `: ${info.dirtyFiles.join(', ')}` : '';
    if (!ALLOW_DIRTY) throw new Error(`refusing to package: gitDirty=${info.gitDirty}${which} (commit first, or pass --allow-dirty for a local test package)`);
    console.warn(`WARNING: packaging a dirty working tree (--allow-dirty)${which}; named -dirty, not for Store upload.`);
  }
  const files = (await walk(OUT)).map((f) => path.relative(OUT, f).split(path.sep).join('/')).sort();
  const entries = await Promise.all(files.map(async (name) => ({ name, data: await readFile(path.join(OUT, name)) })));
  const zip = zipFiles(entries);
  const zipPath = path.join(ROOT, `certscanner-${info.version}${dirty ? '-dirty' : ''}.zip`);
  await writeFile(zipPath, zip);

  // Re-validate what is actually inside the ZIP.
  const back = unzipFiles(await readFile(zipPath));
  const names = new Set(back.map((e) => e.name));
  const problems = [];
  if (back.length !== files.length || files.some((f) => !names.has(f))) problems.push('ZIP entries differ from dist/');
  if ([...names].some((n) => n.startsWith('e2e-harness/') || n.endsWith('.map') || n.startsWith('/') || n.includes('..'))) problems.push('ZIP contains harness, source maps or unsafe paths');
  const manifest = back.find((e) => e.name === 'manifest.json');
  if (!manifest) problems.push('manifest.json missing from ZIP');
  else problems.push(...manifestProblems(manifest.data.toString('utf8'), (f) => names.has(f)));
  const zipInfo = JSON.parse(back.find((e) => e.name === 'build-info.json')?.data.toString('utf8') ?? '{}');
  if (zipInfo.target !== 'release') problems.push('build-info.json inside the ZIP is not a release build');
  if (problems.length) {
    await rm(zipPath, { force: true });
    throw new Error(`package validation failed: ${problems.join('; ')}`);
  }
  console.log(`\npackaged ${rel(zipPath)}: ${back.length} files, ${(zip.length / 1024 / 1024).toFixed(2)} MiB, manifest re-validated inside the ZIP`);
  console.log(`sha256 ${sha256(zip)}  ${path.basename(zipPath)}`);
  console.log(`source ${info.gitCommit}${info.gitDirty ? ' (dirty)' : ''}`);
}

async function check(info) {
  const problems = [];
  const ok = [];
  const fail = (m) => problems.push(m);
  const pass = (m) => ok.push(m);

  // 1. Manifest (release)
  const manifestRaw = await readFile(path.join(OUT, 'manifest.json'), 'utf8');
  const manifestIssues = manifestProblems(manifestRaw, (f) => existsSync(path.join(OUT, f)));
  for (const p of manifestIssues) fail(p);
  if (!manifestIssues.length) pass('manifest: MV3, exact permissions, no host_permissions/<all_urls>, incognito not_allowed, ADR CSP, scan-page command, referenced files exist');

  // 2. No e2e harness in the release build
  if (existsSync(path.join(OUT, 'e2e-harness'))) fail('dist/ contains e2e-harness/'); else pass('no e2e-harness/ in dist/');

  // 3. Vendor files present, hashes match build-info and node_modules
  let vendorOk = true;
  for (const v of VENDOR) {
    const p = path.join(OUT, v.to);
    if (!existsSync(p)) { fail(`missing vendor file ${v.to}`); vendorOk = false; continue; }
    const h = sha256(await readFile(p));
    const recorded = info.vendor.find((x) => x.file === v.to)?.sha256;
    if (h !== recorded || h !== v.sha256) { fail(`vendor hash mismatch ${v.to} (pinned ${v.sha256})`); vendorOk = false; }
  }
  for (const l of LICENSES) {
    if (!existsSync(path.join(OUT, l.to))) { fail(`missing license ${l.to}`); vendorOk = false; continue; }
    if (sha256(await readFile(path.join(OUT, l.to))) !== l.sha256) { fail(`license hash mismatch ${l.to} (pinned ${l.sha256})`); vendorOk = false; }
  }
  for (const f of LINKED_LICENSES) if (!existsSync(path.join(OUT, 'vendor', 'licenses', f))) { fail(`missing linked-library license vendor/licenses/${f}`); vendorOk = false; }
  if (!readFileSync(path.join(OUT, 'vendor', 'THIRD_PARTY_NOTICES.txt'), 'utf8').includes('based in part on the work of the Independent JPEG Group')) { fail('THIRD_PARTY_NOTICES.txt lacks the IJG acknowledgement'); vendorOk = false; }
  if (vendorOk) pass(`vendor: ${VENDOR.length} files + ${LICENSES.length + LINKED_LICENSES.length} licenses present (incl. WASM-linked libraries); vendor files and package licences match the pinned sha256, recorded in build-info.json`);

  // 4. Source scan: URLs, dangerous sinks, inline scripts, remote code
  const srcFiles = (await walk(SRC)).filter((f) => TEXT_EXT.has(path.extname(f)));
  let srcOk = true;
  for (const f of srcFiles) {
    const text = await readFile(f, 'utf8');
    for (const u of text.match(/https?:\/\/[^\s'"`)<>\\]+/g) ?? []) {
      if (/^https?:\/\/\$\{/.test(u)) continue; // host built at runtime from validated data (permission patterns)
      if (f.endsWith('manifest.json') && u === 'https://*/*') continue; // optional_host_permissions match pattern
      if (/^https?:\/\/\*\/\*$/.test(u)) continue; // permission match patterns (host "*"), not endpoints (SEC-11 wildcard detection)
      let host = null;
      try { host = new URL(u.replace(/\$\{.*$/, '')).hostname; } catch { host = null; }
      if (!host || !ALLOWED_URL_HOSTS.has(host)) { fail(`${rel(f)}: URL not allowed: ${u}`); srcOk = false; }
    }
    const sinks = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/, /importScripts\s*\(/, /\bimport\s*\(\s*['"`]https?:/];
    for (const re of sinks) if (re.test(text)) { fail(`${rel(f)}: forbidden construct ${re}`); srcOk = false; }
    if (/cdn\.jsdelivr|unpkg\.com|cdnjs/i.test(text)) { fail(`${rel(f)}: CDN reference`); srcOk = false; }
    if (f.endsWith('.html')) {
      for (const tag of text.match(/<script\b[^>]*>/gi) ?? []) {
        const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
        if (!src) { fail(`${rel(f)}: inline <script> (blocked by CSP)`); srcOk = false; continue; }
        if (/^[a-z]+:/i.test(src) || src.startsWith('//')) { fail(`${rel(f)}: remote script ${src}`); srcOk = false; continue; }
        const target = path.join(path.dirname(path.join(OUT, path.relative(SRC, f))), src);
        if (!existsSync(target)) { fail(`${rel(f)}: script ${src} missing from build`); srcOk = false; }
      }
      if (/\son[a-z]+\s*=\s*["']/i.test(text)) { fail(`${rel(f)}: inline event handler attribute`); srcOk = false; }
    }
  }
  if (srcOk) pass(`src: ${srcFiles.length} files - only grader hosts in URLs, no innerHTML/eval/remote/inline scripts`);

  // 5. Code paths override every vendor default URL
  const ocr = await readFile(path.join(SRC, 'pipeline', 'ocr.js'), 'utf8');
  const bc = await readFile(path.join(SRC, 'pipeline', 'barcode.js'), 'utf8');
  const overrides = ['workerPath', 'corePath', 'langPath', 'workerBlobURL: false', "cacheMethod: 'none'"].every((s) => ocr.includes(s)) && bc.includes('locateFile');
  if (overrides) pass('tesseract workerPath/corePath/langPath and zxing locateFile are overridden to packaged files');
  else fail('vendor path overrides missing in ocr.js/barcode.js');
  const remote = info.vendor.filter((v) => v.remoteUrlStrings.length);
  if (remote.length) pass(`vendor default CDN strings (overridden at runtime): ${remote.map((v) => `${v.file} x${v.remoteUrlStrings.length}`).join(', ')}`);

  // 6. Syntax of every src JS module
  let syntaxOk = true;
  for (const f of srcFiles.filter((x) => x.endsWith('.js'))) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { fail(`syntax: ${rel(f)}: ${String(e.stderr).split('\n').slice(0, 4).join(' ')}`); syntaxOk = false; }
  }
  if (syntaxOk) pass('node --check: all src JS parses');

  // 7. Locales: parity and every referenced key exists
  const en = JSON.parse(await readFile(path.join(SRC, '_locales', 'en', 'messages.json'), 'utf8'));
  const nl = JSON.parse(await readFile(path.join(SRC, '_locales', 'nl', 'messages.json'), 'utf8'));
  const enKeys = Object.keys(en).sort();
  const nlKeys = Object.keys(nl).sort();
  let i18nOk = true;
  for (const k of enKeys) if (!(k in nl)) { fail(`nl locale missing ${k}`); i18nOk = false; }
  for (const k of nlKeys) if (!(k in en)) { fail(`en locale missing ${k}`); i18nOk = false; }
  for (const k of enKeys) if (!/^[a-z][a-z0-9_]*$/.test(k)) { fail(`locale key not snake_case (ADR A3 / UX spec §6): ${k}`); i18nOk = false; }
  // Placeholders must match between locales; descriptions stay <= 132 chars (CWS); no authenticity wording outside the negative notes.
  for (const k of enKeys) {
    if (!(k in nl)) continue;
    const pe = Object.keys(en[k].placeholders ?? {}).sort().join();
    const pn = Object.keys(nl[k].placeholders ?? {}).sort().join();
    if (pe !== pn) { fail(`placeholder mismatch for ${k}: en[${pe}] nl[${pn}]`); i18nOk = false; }
    for (const [lang, msgs] of [['en', en], ['nl', nl]]) {
      const used = [...msgs[k].message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((x) => x[1].toLowerCase()).sort();
      const declared = Object.keys(msgs[k].placeholders ?? {}).map((x) => x.toLowerCase()).sort();
      if (used.some((u) => !declared.includes(u))) { fail(`${lang}.${k}: undeclared placeholder`); i18nOk = false; }
      if (/\b(verified|authentic|genuine|echt)\b/i.test(msgs[k].message) && !['verify_note', 'about_lookup'].includes(k)) { fail(`${lang}.${k}: authenticity wording outside the negative notes`); i18nOk = false; }
    }
  }
  // SEC-02: every shipped locale's description stays within the Chrome Web Store limit.
  for (const lang of await readdir(path.join(SRC, '_locales'))) {
    const msgs = JSON.parse(await readFile(path.join(SRC, '_locales', lang, 'messages.json'), 'utf8'));
    const d = msgs.ext_description?.message ?? '';
    if (!d || d.length > 132) { fail(`${lang}.ext_description is ${d.length} characters (must be 1-132)`); i18nOk = false; }
  }
  const used = new Set();
  for (const k of manifestRaw.match(/__MSG_(\w+)__/g) ?? []) used.add(k.slice(6, -2));
  for (const f of srcFiles) {
    const text = await readFile(f, 'utf8');
    if (f.endsWith('.html')) {
      for (const mm of text.matchAll(/data-i18n="([^"]+)"/g)) used.add(mm[1]);
      for (const mm of text.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of mm[1].split(';')) used.add(pair.split(':')[1]?.trim());
    }
    for (const mm of text.matchAll(/\bt\(\s*'([a-z][a-z0-9_]*)'/g)) used.add(mm[1]);
    for (const mm of text.matchAll(/getMessage\(\s*'([a-z][a-z0-9_]*)'/g)) used.add(mm[1]);
    // Keys referenced from data tables, e.g. { k: 'err_restricted' } -> err_restricted_heading/_body, or key: 'method_ocr'
    const bases = new Set();
    for (const mm of text.matchAll(/\bk:\s*'([a-z][a-z0-9_]*)'/g)) { bases.add(mm[1]); used.add(`${mm[1]}_heading`); used.add(`${mm[1]}_body`); }
    for (const mm of text.matchAll(/'((?:method|reason|step|err|warn|grader|status|image|perm|recent|setting|settings|about|lowres|url)_[a-z0-9_]+)'/g)) if (!bases.has(mm[1])) used.add(mm[1]);
  }
  used.delete(undefined);
  for (const k of used) if (!(k in en)) { fail(`locale key used but not defined: ${k}`); i18nOk = false; }
  if (i18nOk) pass(`locales: en/nl parity (${enKeys.length} keys), ${used.size} referenced keys defined`);

  console.log('\nCertScanner check');
  for (const s of ok) console.log(`  PASS  ${s}`);
  for (const s of problems) console.log(`  FAIL  ${s}`);
  console.log(problems.length ? `\n${problems.length} problem(s)` : '\nall checks passed');
  return problems.length === 0;
}

try {
  const info = await build();
  if (CHECK && !(await check(info))) process.exit(1);
  if (PACKAGE) await packageZip(info);
} catch (e) {
  console.error(`build failed: ${e.message}`);
  process.exit(1);
}
