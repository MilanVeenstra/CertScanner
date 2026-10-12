// Shared e2e harness (QA-owned, test-side only; nothing here ships in the extension).
//
// - Loads the built `dist-e2e/` (npm run build:e2e) into Playwright's bundled Chromium with an isolated,
//   throw-away profile (launchPersistentContext + --load-extension).
// - Hermetic network: every host except 127.0.0.1/localhost resolves to NOTFOUND (grader hosts included),
//   no proxy, and the browser gets a minimal environment (no proxy variables, no credentials).
// - Serves fixtures on three local origins: A = pages, B = images without CORS (+ /hotlink/ that only
//   answers <img> loads), C = images with CORS.
// - Records every request seen in the context: tabs, extension pages, dedicated workers and (with
//   PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS) the extension service worker.
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Read by Playwright when it attaches to a service worker: report SW network requests too.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DIST_E2E = process.env.CERTSCANNER_E2E_DIST ? path.resolve(process.env.CERTSCANNER_E2E_DIST) : path.join(ROOT, 'dist-e2e');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
export const BENCH = path.join(FIXTURES, 'bench');
export const BENCH_REAL = path.join(FIXTURES, 'bench-real');
export const CHROME = process.env.CERTSCANNER_CHROMIUM
  || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);

export const GRADER_HOSTS = Object.freeze(['psacard.com', 'www.psacard.com', 'cgccomics.com', 'www.cgccomics.com',
  'cgccards.com', 'www.cgccards.com', 'cgccards.uk', 'www.cgccards.uk', 'beckett.com', 'www.beckett.com']);
export const CERT_URL = Object.freeze({
  psa: (n) => `https://www.psacard.com/cert/${n}`,
  'cgc-comics': (n) => `https://www.cgccomics.com/certlookup/${n}/`,
  'cgc-cards': (n) => `https://www.cgccards.com/certlookup/${n}/`,
  bgs: () => 'https://www.beckett.com/grading/card-lookup', // lookup form; the number is copied, never in the URL
});
// A9 adds 'page-results' (page scan with a list of numbers). 'idle' is where a cancelled scan ends.
export const TERMINAL_STATES = Object.freeze(['idle', 'auto-open', 'confirm', 'none', 'error', 'opened', 'page-results']);
export const HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
export const isGraderUrl = (u) => GRADER_HOSTS.includes(hostOf(u));

export function assertBuilt() {
  const info = path.join(DIST_E2E, 'build-info.json');
  if (!existsSync(path.join(DIST_E2E, 'manifest.json')) || !existsSync(info)) {
    throw new Error('dist-e2e/ is missing: run `npm run build:e2e` (or `npm run e2e`, which builds first).');
  }
  const build = JSON.parse(readFileSync(info, 'utf8'));
  if (build.target !== 'e2e') throw new Error('dist-e2e/build-info.json is not an e2e build');
  return build;
}

export async function poll(fn, { timeout = 15000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`timed out waiting for ${message}${last instanceof Error ? `: ${last.message}` : ''}`);
    await sleep(interval);
  }
}

/** Minimal environment for the browser process: no proxies, no tokens or cloud credentials. */
function browserEnv(extra = {}) {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'FONTCONFIG_PATH', 'XDG_RUNTIME_DIR'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.TZ ??= 'UTC';
  return { ...env, ...extra };
}

// ------------------------------------------------------------------------------------------------
// Fixture servers
// ------------------------------------------------------------------------------------------------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

function resolveUnder(base, rel) {
  const p = path.resolve(base, rel);
  return p.startsWith(base + path.sep) ? p : null;
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Start origins A (pages), B (images, no CORS) and C (images, CORS).
 * Every request is appended to `log` as {server, method, path, dest, origin}.
 */
export async function startServers() {
  const log = [];
  const record = (server, req) => {
    const { pathname } = new URL(req.url, 'http://x');
    log.push({ server, method: req.method, path: pathname, dest: req.headers['sec-fetch-dest'] ?? null, origin: req.headers.origin ?? null });
  };
  const sendFile = async (res, file, headers = {}) => {
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store', ...headers });
      res.end(body);
    } catch {
      res.writeHead(404, headers).end('not found');
    }
  };

  const a = await listen(async (req, res) => {
    record('A', req);
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__e2e/page.html') {
      // Synthetic listing with one image from any origin: ?img=<url>&w=<css px>&id=<element id>
      const img = url.searchParams.get('img') ?? '';
      const w = Number(url.searchParams.get('w') ?? 300) || 300;
      const id = (url.searchParams.get('id') ?? 'img-under-test').replace(/[^\w-]/g, '');
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>e2e listing</title>
<style>body{margin:0;padding:16px;font-family:sans-serif;background:#fafafa}img{display:block}</style></head>
<body><h1 style="font-size:16px;margin:0 0 8px">Synthetic listing (CertScanner e2e)</h1>
<img id="${id}" src="${esc(img)}" width="${w}" alt="Synthetic slab photo">
<script>document.getElementById('${id}').decode().then(()=>{document.documentElement.dataset.ready='1'},()=>{document.documentElement.dataset.ready='error'});</script>
</body></html>`);
      return;
    }
    const file = resolveUnder(FIXTURES, decodeURIComponent(url.pathname.slice(1)));
    if (!file) { res.writeHead(404).end(); return; }
    await sendFile(res, file);
  });

  const b = await listen(async (req, res) => {
    record('B', req);
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname.slice(1));
    if (rel.startsWith('hotlink/')) {
      // Hotlink-protected CDN: only <img> loads succeed; fetch() from the extension or the page gets 403.
      if (req.headers['sec-fetch-dest'] !== 'image') { res.writeHead(403, { 'content-type': 'text/plain' }).end('hotlink denied'); return; }
      rel = rel.slice('hotlink/'.length);
    }
    const file = resolveUnder(FIXTURES, rel);
    if (!file) { res.writeHead(404).end(); return; }
    await sendFile(res, file);
  });

  const c = await listen(async (req, res) => {
    record('C', req);
    const url = new URL(req.url, 'http://x');
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET' }).end(); return; }
    const file = resolveUnder(FIXTURES, decodeURIComponent(url.pathname.slice(1)));
    if (!file) { res.writeHead(404, cors).end(); return; }
    await sendFile(res, file, cors);
  });

  const origin = (s) => `http://127.0.0.1:${s.address().port}`;
  return {
    A: origin(a), B: origin(b), C: origin(c),
    ports: [a, b, c].map((s) => s.address().port),
    log,
    close: () => Promise.all([a, b, c].map((s) => new Promise((r) => s.close(r)))),
  };
}

// ------------------------------------------------------------------------------------------------
// Browser + extension
// ------------------------------------------------------------------------------------------------

/** Copy dist-e2e and patch its manifest (used for the "no https grant" variant). */
export async function makeVariant(patch) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'certscanner-variant-'));
  await cp(DIST_E2E, dir, { recursive: true });
  const mf = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  patch(mf);
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(mf, null, 2)}\n`);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Launch Chromium with the extension. Returns helpers bound to the context.
 * @param {{extensionPath?:string, args?:string[], env?:Record<string,string>}} [opts]  env: extra browser variables (e.g. LANGUAGE)
 */
export async function launchExtension({ extensionPath = DIST_E2E, args = [], env: extraEnv = {} } = {}) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'certscanner-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: true,
    viewport: null,
    env: browserEnv(extraEnv),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1280,1000',
      '--no-proxy-server',
      `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
      ...args,
    ],
  });

  // Network log: every request in the context (tabs, extension pages, workers, service worker).
  const net = [];
  const describe = (r) => {
    let where = 'unknown';
    try { if (r.serviceWorker()) where = 'service-worker'; } catch { /* older API */ }
    if (where === 'unknown') { try { where = r.frame().page().url(); } catch { where = 'worker'; } }
    return where;
  };
  context.on('request', (r) => net.push({ url: r.url(), type: r.resourceType(), where: describe(r), failure: null, status: null, req: r }));
  context.on('requestfailed', (r) => { const e = net.find((x) => x.req === r); if (e) e.failure = r.failure()?.errorText ?? 'failed'; });
  context.on('requestfinished', async (r) => {
    const e = net.find((x) => x.req === r);
    if (e) { try { e.status = (await r.response())?.status() ?? null; } catch { /* gone */ } }
  });

  let sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(sw.url()).host;
  // chrome.* is not ready the instant the serviceworker event fires.
  await poll(() => sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.windows && !!chrome.tabs && !!chrome.storage?.session),
    { message: 'chrome.* in the service worker' });

  const browserVersion = context.browser()?.version() ?? (await sw.evaluate(() => navigator.userAgent)).match(/Chrome\/([\d.]+)/)?.[1];

  const env = {
    context, extensionId, userDataDir, net, browserVersion,
    get sw() { return sw; },
    /**
     * Use another trusted extension context (e.g. the panel page) for chrome.* helper calls. Needed after a
     * service-worker stop: Chromium restarts the worker, but Playwright 1.56 does not surface the new instance.
     */
    setDriver(target) { sw = target; },
    url: (p) => `chrome-extension://${extensionId}/${p}`,
    async close() {
      await context.close().catch(() => {});
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return env;
}

// ------------------------------------------------------------------------------------------------
// Service-worker helpers (chrome.* from the extension's own worker)
// ------------------------------------------------------------------------------------------------
export async function allTabs(env) {
  return env.sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({
    id: t.id, windowId: t.windowId, index: t.index, active: t.active, openerTabId: t.openerTabId ?? null,
    url: t.url || t.pendingUrl || '', pendingUrl: t.pendingUrl ?? null,
  })));
}

export async function graderTabs(env) {
  return (await allTabs(env)).filter((t) => isGraderUrl(t.url) || isGraderUrl(t.pendingUrl ?? ''));
}

export async function closeGraderTabs(env) {
  const ids = (await graderTabs(env)).map((t) => t.id);
  if (ids.length) await env.sw.evaluate((x) => chrome.tabs.remove(x), ids);
}

/** Find the tab showing `urlPrefix` (polls until present). */
export async function findTab(env, urlPrefix) {
  return poll(async () => (await allTabs(env)).find((t) => t.url.startsWith(urlPrefix)), { message: `tab ${urlPrefix}` });
}

/** Mirror of jobContract.minimizePageUrl (ADR A7 / SEC-09): scheme + host + path only. */
export function minimizePageUrl(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const origin = u.origin && u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`;
  return `${origin}${u.pathname}`;
}

/**
 * Write a ScanJob v1 for `windowId` into chrome.storage.session from the service worker, shaped like
 * sw.js/createScanJob after amendment A7 (no frameUrl, pageUrl without query/hash).
 */
export async function writeJob(env, { windowId, tabId, srcUrl, pageUrl, frameId = 0, ageMs = 0, overrides = {} }) {
  return env.sw.evaluate(async (a) => {
    const job = {
      v: 1, id: crypto.randomUUID(), createdAt: Date.now() - a.ageMs, source: 'contextMenu', srcUrl: a.srcUrl,
      pageUrl: a.pageUrl, frameId: a.frameId, tabId: a.tabId, windowId: a.windowId, mediaType: 'image',
      ...a.overrides,
    };
    await chrome.storage.session.set({ [`scanJob:${a.windowId}`]: job });
    return job;
  }, { windowId, tabId, srcUrl, pageUrl: minimizePageUrl(pageUrl), frameId, ageMs, overrides });
}

/**
 * Write an A9 page job (toolbar icon / Alt+Shift+S / panel button) exactly like sw.js createPageJob():
 * {v:1, id, createdAt, kind:'page', source, srcUrl:null, pageUrl:<origin+path>, frameId:0, tabId, windowId}, no mediaType.
 * The real triggers (icon click, shortcut) also grant activeTab and call sidePanel.open(); neither is automatable, so
 * dist-e2e's <all_urls> stands in for the grant. `pageUrl:''` reproduces a tab whose URL Chrome hides.
 */
export async function writePageJob(env, { windowId, tabId, pageUrl, source = 'action', ageMs = 0, overrides = {} }) {
  return env.sw.evaluate(async (a) => {
    const job = {
      v: 1, id: crypto.randomUUID(), createdAt: Date.now() - a.ageMs, kind: 'page', source: a.source, srcUrl: null,
      pageUrl: a.pageUrl, frameId: 0, tabId: a.tabId, windowId: a.windowId, ...a.overrides,
    };
    await chrome.storage.session.set({ [`scanJob:${a.windowId}`]: job });
    return job;
  }, { windowId, tabId, pageUrl: pageUrl === '' ? '' : minimizePageUrl(pageUrl), source, ageMs, overrides });
}

export async function sessionGet(env, key) {
  return env.sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, key);
}

// ------------------------------------------------------------------------------------------------
// Side panel page (opened as the popup-window fallback, `?w=<target window>`)
// ------------------------------------------------------------------------------------------------
const RECORDER = () => {
  const install = () => {
    if (window.__cs) return;
    const log = [];
    const push = () => log.push({ state: document.body?.dataset.state ?? null, t: performance.now() });
    push();
    new MutationObserver(push).observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
    window.__cs = { log };
  };
  if (document.body) install(); else document.addEventListener('DOMContentLoaded', install, { once: true });
};

/**
 * Open sidepanel.html?w=<targetWindowId> in its own popup window (like the sw.js fallback).
 * @returns {Promise<{page:import('playwright').Page, windowId:number, errors:string[]}>}
 */
export async function openPanel(env, targetWindowId, { width = 420, height = 900 } = {}) {
  const url = env.url(`sidepanel/sidepanel.html?w=${targetWindowId}`);
  const pagePromise = env.context.waitForEvent('page', { predicate: (p) => p.url() === url, timeout: 20000 });
  const windowId = await env.sw.evaluate(async (a) => (await chrome.windows.create({ type: 'popup', url: a.url, width: a.width, height: a.height, focused: false })).id,
    { url, width, height });
  const page = await pagePromise;
  const errors = watchErrors(page);
  await page.addInitScript(RECORDER);
  await page.waitForSelector('body[data-ready="1"]', { state: 'attached', timeout: 20000 });
  await page.evaluate(RECORDER);
  return { page, windowId, errors };
}

/** Collect uncaught errors and console errors of a page. */
export function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  return errors;
}

export async function reloadPanel(page) {
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]', { state: 'attached', timeout: 20000 });
  await page.evaluate(RECORDER);
}

export async function logMark(page) {
  return page.evaluate(() => window.__cs.log.length);
}

export async function stateLog(page, mark = 0) {
  return page.evaluate((m) => window.__cs.log.slice(m).map((e) => e.state), mark);
}

/** Wait until a scan that starts after `mark` reaches a terminal body[data-state]. */
export async function waitForScanEnd(page, mark, { timeout = 45000 } = {}) {
  await page.waitForFunction(({ m, terminal }) => {
    const after = (window.__cs?.log ?? []).slice(m);
    const i = after.findIndex((e) => e.state === 'scanning');
    return i >= 0 && after.slice(i + 1).some((e) => terminal.includes(e.state));
  }, { m: mark, terminal: TERMINAL_STATES }, { timeout, polling: 50 });
  return readResult(page);
}

/** Read the visible result through the §13 test ids only. */
export async function readResult(page) {
  return page.evaluate(() => {
    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    const visible = (el) => !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0;
    const gs = q('grader-select');
    let grader = null;
    if (gs instanceof HTMLSelectElement) grader = gs.value || null;
    else if (gs && visible(gs)) {
      const r = gs.querySelector('input[type=radio]:checked, [aria-checked="true"], [aria-pressed="true"]');
      grader = r ? (r.value || r.dataset.value || null) : (gs.dataset.value || null);
    }
    // Result views without the grader control (auto-open / opened) show the official URL (result-url).
    const urlText = visible(q('result-url')) ? q('result-url').textContent : '';
    if (!grader && urlText) grader = /psacard\./.test(urlText) ? 'psa' : /cgccomics\./.test(urlText) ? 'cgc-comics' : /cgccards\./.test(urlText) ? 'cgc-cards' : /beckett\./.test(urlText) ? 'bgs' : null;
    // BGS has no per-number page: before the lookup opens, the grader chip is the only place the grader shows.
    if (!grader && visible(q('result-grader'))) grader = q('result-grader').dataset.grader || null;
    const numberText = q('result-number')?.textContent ?? '';
    const err = q('error-message');
    return {
      state: document.body.dataset.state,
      number: visible(q('result-number')) ? numberText.replace(/\D/g, '') || null : null,
      resultUrl: urlText.trim(),
      grader,
      candidates: [...document.querySelectorAll('[data-testid]')].filter((e) => /^candidate-\d+$/.test(e.dataset.testid)).length,
      error: visible(err) ? err.textContent.trim() : '',
      sharperVisible: visible(q('sharper-button')),
      sharperText: q('sharper-button')?.textContent.trim() ?? '',
      status: q('status-live')?.textContent.trim() ?? '',
    };
  });
}

/** Upload a file through the panel's upload input and wait for the scan to finish. */
export async function uploadAndWait(page, file, opts) {
  const mark = await logMark(page);
  const t0 = Date.now();
  await page.locator('[data-testid="upload-input"]').setInputFiles(file);
  const result = await waitForScanEnd(page, mark, opts);
  return { ...result, wallMs: Date.now() - t0 };
}

/** Run scan() directly in the panel realm (same module instance and engines as the UI). */
export async function scanInPanel(page, input, options = {}) {
  return page.evaluate(async ({ input, options }) => {
    const { scan } = await import(chrome.runtime.getURL('pipeline/scanner.js'));
    let real = input;
    if (input.kind === 'blob-url') {
      const blob = await (await fetch(input.url)).blob();
      real = { kind: 'blob', blob, method: 'upload' };
    } else if (input.kind === 'blob-b64') {
      const bytes = Uint8Array.from(atob(input.b64), (c) => c.charCodeAt(0));
      real = { kind: 'blob', blob: new Blob([bytes], { type: input.type }), method: 'upload' };
    }
    const settings = options.settings ?? { v: 1, autoOpen: true, openInBackground: false, saveHistory: false };
    const r = await scan(real, { settings, acquire: options.acquire });
    return JSON.parse(JSON.stringify(r));
  }, { input, options });
}

// ------------------------------------------------------------------------------------------------
// Chrome NetLog (--log-net-log): browser-wide record of every URLRequest, from any context.
// ------------------------------------------------------------------------------------------------
/** Traffic annotations of renderer-originated traffic (navigations and Blink fetches/subresources). */
export const RENDERER_ANNOTATIONS = Object.freeze({ 63171670: 'navigation_url_loader', 101845102: 'blink_resource_loader', 112189210: 'favicon_loader' });

/** Parse a (possibly unterminated) NetLog JSON into one record per URL request. */
export function parseNetLog(text) {
  let j;
  try { j = JSON.parse(text); } catch { j = JSON.parse(`${text.trim().replace(/,$/, '')}]}`); }
  const types = Object.fromEntries(Object.entries(j.constants.logEventTypes).map(([k, v]) => [v, k]));
  const errors = Object.fromEntries(Object.entries(j.constants.netError ?? {}).map(([k, v]) => [v, k]));
  const bySource = new Map();
  for (const ev of j.events) {
    const type = types[ev.type];
    const p = ev.params ?? {};
    const rec = bySource.get(ev.source.id) ?? {};
    if (type === 'REQUEST_ALIVE' && 'traffic_annotation' in p) rec.annotation = p.traffic_annotation;
    if (type === 'URL_REQUEST_START_JOB' && typeof p.url === 'string') {
      Object.assign(rec, { url: p.url, initiator: p.initiator ?? null, requestType: p.request_type ?? null, method: p.method ?? null });
    }
    if ((type === 'URL_REQUEST_START_JOB' || type === 'REQUEST_ALIVE') && ev.phase === 2 && typeof p.net_error === 'number') {
      rec.netError = errors[p.net_error] ?? String(p.net_error);
    }
    bySource.set(ev.source.id, rec);
  }
  return [...bySource.values()].filter((r) => r.url).map((r) => ({
    ...r,
    renderer: Object.prototype.hasOwnProperty.call(RENDERER_ANNOTATIONS, r.annotation),
    annotationName: RENDERER_ANNOTATIONS[r.annotation] ?? `other:${r.annotation}`,
  }));
}

// ------------------------------------------------------------------------------------------------
// HTTPS image origin (self-signed, test-only; launch with --ignore-certificate-errors)
// ------------------------------------------------------------------------------------------------
export async function startHttpsImageServer() {
  const { execFileSync } = await import('node:child_process');
  const https = await import('node:https');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'certscanner-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const log = [];
  const server = https.createServer({ key: await readFile(path.join(dir, 'key.pem')), cert: await readFile(path.join(dir, 'cert.pem')) }, async (req, res) => {
    const { pathname } = new URL(req.url, 'https://x');
    log.push({ path: pathname, dest: req.headers['sec-fetch-dest'] ?? null });
    const file = resolveUnder(FIXTURES, decodeURIComponent(pathname.slice(1)));
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `https://127.0.0.1:${server.address().port}`,
    log,
    close: async () => { await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); },
  };
}
