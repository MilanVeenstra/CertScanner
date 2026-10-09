#!/usr/bin/env node
/**
 * CertScanner build (ADR-001 §12, §14). No bundler: copies src/ plus the pinned vendor files.
 *
 *   node scripts/build.mjs           -> dist/      (release layout; load unpacked or zip)
 *   node scripts/build.mjs --e2e     -> dist-e2e/  (dist + e2e-harness/ from tests/e2e/harness/ + host_permissions ["<all_urls>"])
 *   node scripts/build.mjs --check   -> builds dist/ and validates it (exit 1 on any failure)
 *
 * Env: SOURCE_DATE_EPOCH (seconds) makes builtAt reproducible.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const NM = path.join(ROOT, 'node_modules');
const args = new Set(process.argv.slice(2));
for (const a of args) if (!['--e2e', '--check'].includes(a)) { console.error(`Unknown argument: ${a}`); process.exit(2); }
const E2E = args.has('--e2e');
const CHECK = args.has('--check');
if (E2E && CHECK) { console.error('--e2e and --check are exclusive (check validates the release dist/)'); process.exit(2); }
const OUT = path.join(ROOT, E2E ? 'dist-e2e' : 'dist');

/** Executable/data files shipped from node_modules (ADR §12). */
const VENDOR = [
  { pkg: 'tesseract.js', from: 'tesseract.js/dist/tesseract.min.js', to: 'vendor/tesseract/tesseract.min.js' },
  { pkg: 'tesseract.js', from: 'tesseract.js/dist/worker.min.js', to: 'vendor/tesseract/worker.min.js' },
  { pkg: 'tesseract.js-core', from: 'tesseract.js-core/tesseract-core-simd-lstm.js', to: 'vendor/tesseract/tesseract-core-simd-lstm.js' },
  { pkg: 'tesseract.js-core', from: 'tesseract.js-core/tesseract-core-simd-lstm.wasm', to: 'vendor/tesseract/tesseract-core-simd-lstm.wasm' },
  { pkg: '@tesseract.js-data/eng', from: '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', to: 'vendor/tesseract/lang/eng.traineddata.gz' },
  { pkg: 'zxing-wasm', from: 'zxing-wasm/dist/iife/reader/index.js', to: 'vendor/zxing/zxing-reader.iife.js' },
  { pkg: 'zxing-wasm', from: 'zxing-wasm/dist/reader/zxing_reader.wasm', to: 'vendor/zxing/zxing_reader.wasm' },
];
const LICENSES = [
  { from: 'tesseract.js/LICENSE.md', to: 'vendor/tesseract/LICENSE-tesseract.js.md' },
  { from: 'tesseract.js/dist/tesseract.min.js.LICENSE.txt', to: 'vendor/tesseract/tesseract.min.js.LICENSE.txt' },
  { from: 'tesseract.js/dist/worker.min.js.LICENSE.txt', to: 'vendor/tesseract/worker.min.js.LICENSE.txt' },
  { from: 'tesseract.js-core/LICENSE', to: 'vendor/tesseract/LICENSE-tesseract.js-core.txt' },
  { from: 'zxing-wasm/LICENSE', to: 'vendor/zxing/LICENSE-zxing-wasm.txt' },
];
const EXPECTED_VERSIONS = { 'tesseract.js': '7.0.0', 'tesseract.js-core': /^7\./, '@tesseract.js-data/eng': '1.0.0', 'zxing-wasm': '3.1.5' };

/** Hosts allowed to appear as http(s) URLs anywhere in src/** (CERT_URL / QR_HOSTS only). */
const ALLOWED_URL_HOSTS = new Set([
  'www.psacard.com', 'psacard.com', 'www.cgccomics.com', 'cgccomics.com', 'www.cgccards.com', 'cgccards.com', 'www.cgccards.uk', 'cgccards.uk',
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
  const dirty = git('status', '--porcelain', '--', 'src', 'scripts/build.mjs', 'package.json', 'package-lock.json');
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  const info = {
    name: 'CertScanner',
    version: manifest.version,
    gitCommit: commit,
    gitDirty: dirty === null ? null : dirty.length > 0,
    builtAt: new Date(Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.now()).toISOString(),
    target: E2E ? 'e2e' : 'release',
    e2eHarness: harness,
    vendor: vendorInfo,
  };
  await writeFile(path.join(OUT, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);

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
  Built from zxing-cpp (Apache-2.0).

All code, WebAssembly and model data are packaged with the extension; nothing is downloaded at runtime.
`;
}

// ------------------------------------------------------------------------------------------------
// --check
// ------------------------------------------------------------------------------------------------
async function check(info) {
  const problems = [];
  const ok = [];
  const fail = (m) => problems.push(m);
  const pass = (m) => ok.push(m);

  // 1. Manifest (release)
  const manifestRaw = await readFile(path.join(OUT, 'manifest.json'), 'utf8');
  const m = JSON.parse(manifestRaw);
  if (m.manifest_version !== 3) fail('manifest_version must be 3');
  if ('host_permissions' in m) fail('release manifest must not declare host_permissions');
  if (manifestRaw.includes('<all_urls>')) fail('release manifest must not mention <all_urls>');
  for (const k of ['content_scripts', 'web_accessible_resources', 'externally_connectable']) if (k in m) fail(`manifest must not declare ${k}`);
  const perms = [...(m.permissions ?? [])].sort();
  if (JSON.stringify(perms) !== JSON.stringify([...REQUIRED_PERMISSIONS].sort())) fail(`permissions ${JSON.stringify(m.permissions)} != ${JSON.stringify(REQUIRED_PERMISSIONS)}`);
  if (JSON.stringify(m.optional_host_permissions) !== JSON.stringify(['https://*/*'])) fail('optional_host_permissions must be ["https://*/*"]');
  if (m.content_security_policy?.extension_pages !== RELEASE_CSP) fail('extension_pages CSP differs from ADR §3');
  if (m.minimum_chrome_version !== '116') fail('minimum_chrome_version must be 116');
  const referenced = [m.background?.service_worker, m.side_panel?.default_path, ...Object.values(m.icons ?? {})].filter(Boolean);
  for (const f of referenced) if (!existsSync(path.join(OUT, f))) fail(`manifest references missing file ${f}`);
  if (!problems.length) pass('manifest: MV3, exact permissions, no host_permissions/<all_urls>, ADR CSP, referenced files exist');

  // 2. No e2e harness in the release build
  if (existsSync(path.join(OUT, 'e2e-harness'))) fail('dist/ contains e2e-harness/'); else pass('no e2e-harness/ in dist/');

  // 3. Vendor files present, hashes match build-info and node_modules
  let vendorOk = true;
  for (const v of VENDOR) {
    const p = path.join(OUT, v.to);
    if (!existsSync(p)) { fail(`missing vendor file ${v.to}`); vendorOk = false; continue; }
    const h = sha256(await readFile(p));
    const recorded = info.vendor.find((x) => x.file === v.to)?.sha256;
    if (h !== recorded || h !== sha256(await readFile(path.join(NM, v.from)))) { fail(`vendor hash mismatch ${v.to}`); vendorOk = false; }
  }
  for (const l of LICENSES) if (!existsSync(path.join(OUT, l.to))) { fail(`missing license ${l.to}`); vendorOk = false; }
  if (vendorOk) pass(`vendor: ${VENDOR.length} files + ${LICENSES.length} licenses present, sha256 recorded in build-info.json`);

  // 4. Source scan: URLs, dangerous sinks, inline scripts, remote code
  const srcFiles = (await walk(SRC)).filter((f) => TEXT_EXT.has(path.extname(f)));
  let srcOk = true;
  for (const f of srcFiles) {
    const text = await readFile(f, 'utf8');
    for (const u of text.match(/https?:\/\/[^\s'"`)<>\\]+/g) ?? []) {
      if (/^https?:\/\/\$\{/.test(u)) continue; // host built at runtime from validated data (permission patterns)
      if (f.endsWith('manifest.json') && u === 'https://*/*') continue; // optional_host_permissions match pattern
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
  for (const [lang, msgs] of [['en', en], ['nl', nl]]) {
    const d = msgs.ext_description?.message ?? '';
    if (d.length > 132) { fail(`${lang}.ext_description is ${d.length} > 132 characters`); i18nOk = false; }
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
} catch (e) {
  console.error(`build failed: ${e.message}`);
  process.exit(1);
}
