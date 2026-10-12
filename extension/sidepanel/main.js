// Side-panel bootstrap and state flow (UX spec §3; ADR §4, §13, A4, A5, A9).
// body[data-state] keeps the §13 values (+ 'opened', 'page-results'); the finer task-card state lives on
// section#task[data-state].
import { applyI18n, t } from '../shared/i18n.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, onSettingsChanged } from '../shared/settings.js';
import { loadHistory, clearHistory, onHistoryChanged, MAX_HISTORY } from '../shared/history.js';
import { saveLastResult, loadLastResult, clearLastResult, clearAllLastResults } from '../shared/lastResult.js';
import { buildCertUrl, isValidCert } from '../core/certUrls.js';
import { scan, readLabel, disposeEngines } from '../pipeline/scanner.js';
import { scanPage } from '../pipeline/pageScan.js';
import { imageOriginOf } from '../pipeline/acquire.js';
import { hintText } from '../pipeline/probeValidate.js';
import { createPageJob } from '../shared/jobContract.js';
import { createUi, graderName } from './ui.js';
import { createCertField } from './certField.js';
import { decide } from '../core/routing.js';
import { confirmReasons, errorView, sharperOfferHost, autoOpenKey, openedStatusKey, MAX_IMAGE_MB } from './viewModel.js';
import { resolveTargetWindowId, startJobIntake } from './jobIntake.js';
import { openCert, openPriceLink, recordHistory } from './opener.js';
import { cardInfo, gradeQuery, slabQuery, ebaySearchUrl, cardNoFrom, specialGrade, POP_URLS } from '../core/priceLinks.js';
import { isPcUrl, searchUrl as pcSearchUrl } from '../core/pricecharting.js';
import { loadPrices, requestPricePermission } from './priceData.js';
import { fetchPsaCert, loadPsaToken, savePsaToken, clearPsaToken, isPsaToken, PSA_API_PERMISSION, PSA_API_SIGNUP } from './psaApi.js';
import { loadPptPrices, loadPptToken, savePptToken, clearPptToken, isPptToken } from './pptApi.js';
import { isPokemon, PPT_PERMISSION, PPT_SIGNUP } from '../core/ppt.js';
import { wireInputs } from './inputs.js';
import { makeThumbBlob } from './thumbs.js';
import { requestSharper, listGrantedSites, removeSite, removeAllSites, removalStatus, onPermissionsChanged } from './permissionsUi.js';
import {
  SHORTCUTS_URL, scanShortcut, panelScanPlan, alwaysAllowHost, accessBody, noAccessBody, idleShortcutHint, pageSummary,
  pageNoneReason, pageQrInfo, pageErrorCode, persistablePage,
} from './pageView.js';

const DECLINED_KEY = 'sharperDeclined';
const doc = document;
const $ = (id) => doc.getElementById(id);

applyI18n(doc);

let settings = { ...DEFAULT_SETTINGS };
let windowId = null;
let history = { v: 1, entries: [] };
/** In-flight scan. */
let current = null;
/** Last completed scan context: what Try again / Scan again / Copy / Edit act on. `page`: the A9 results list. */
/** thumbUrl: small preview (<= 240 px); fullBlob: the original image, decoded only for "Show larger" (perf rec. 1). */
const blankLast = () => ({ input: null, job: null, result: null, opened: null, thumbUrl: null, fullBlob: null, thumbAlt: '', caption: '', imageHost: null, picked: null, lowres: null, page: null, labelLines: null, labelFor: null });
let last = blankLast();
const autoOpened = new Set();
const declined = new Set(); // hosts where "Sharper scans" was denied or dismissed this session
/** Page-scan shortcut as Chrome reports it ('' = not set). */
let shortcut = '';
/** Object URLs of the current page scan's small row thumbnails; revoked when the next scan starts. */
let pageThumbs = [];
/** Original blobs of the current page scan's images (for "Show larger" after "Choose grader"); dropped with the thumbs. */
let pageBlobs = [];
/** A9 page-access state: the tab it is about and the https host that "Always allow" would grant. */
let access = null;
/**
 * Last URL this panel saw for a tab (from a job or a readable tabs.query). Chrome hides the URL of tabs CertScanner
 * can't read, so this is the only way to name the host for "Always allow"; dropped as soon as the tab navigates
 * somewhere the panel can't see.
 */
const tabSites = new Map();

const ui = createUi(doc, {
  submitTaskForm: () => onTaskFormSubmit(),
  candidatePicked: (c) => { last.picked = c; },
  pricesChanged: () => refreshPrices({ fromCert: false }),
});

// ---------------------------------------------------------------- static texts with substitutions
const isMac = /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
$('right-click-tip').textContent = t('right_click_tip', [t('context_menu_scan')]);
$('paste-hint').textContent = t('paste_hint', [t(isMac ? 'shortcut_paste_mac' : 'shortcut_paste_other')]);
$('drop-formats').textContent = t('drop_formats', [t('size_mb', [String(MAX_IMAGE_MB)])]);
$('hint-history').textContent = t('setting_history_hint', [String(MAX_HISTORY)]);
$('about-version').textContent = t('about_version', [chrome.runtime.getManifest().version]);

// ---------------------------------------------------------------- helpers
const hostOf = (url) => { try { return new URL(url).hostname || null; } catch { return null; } };
const idleHint = () => idleShortcutHint({ scanOnClick: settings.scanOnToolbarClick !== false, shortcut });
const accessCopy = () => accessBody({ scanOnClick: settings.scanOnToolbarClick !== false, shortcut });
const noAccessCopy = () => noAccessBody({ scanOnClick: settings.scanOnToolbarClick !== false, shortcut });

ui.renderShortcut(shortcut);
ui.showIdle({ hint: idleHint() });

function rememberTab(tabId, url) {
  if (Number.isInteger(tabId) && typeof url === 'string' && url) tabSites.set(tabId, url);
}

function revokePageThumbs() {
  for (const u of pageThumbs) if (u) URL.revokeObjectURL(u);
  pageThumbs = [];
  pageBlobs = [];
}

function showIdleCard({ focus = false } = {}) {
  setBody('idle');
  ui.showIdle({ focus, hint: idleHint() });
}

/** Shortcut text from Chrome; refreshed on load and whenever the panel regains focus (no commands.onChanged). */
async function refreshShortcut() {
  let s = '';
  try { s = scanShortcut(await chrome.commands.getAll()); } catch { s = ''; }
  shortcut = s;
  ui.renderShortcut(shortcut);
  ui.updateIdleHint(idleHint());
  ui.updateAccessBody(accessCopy());
  ui.updateNoAccessBody(noAccessCopy());
}

function describeInput(input) {
  if (input.kind === 'job') {
    const host = hostOf(imageOriginOf(input.job.srcUrl ?? '') ?? '') ?? hostOf(input.job.pageUrl);
    return host ? { caption: t('image_source_page', [host]), alt: t('image_alt_page', [host]), host } : { caption: '', alt: '', host: null };
  }
  if (input.method === 'paste') return { caption: t('image_alt_pasted'), alt: t('image_alt_pasted'), host: null };
  const name = String(input.blob?.name ?? '').slice(0, 120);
  return name ? { caption: name, alt: t('image_alt_file', [name]), host: null } : { caption: t('image_alt_pasted'), alt: t('image_alt_pasted'), host: null };
}

function qrInfo(result) {
  const w = (result.warnings ?? []).find((x) => x.code === 'qr-untrusted-host');
  if (!w) return { qrHost: null, qrNumberUsed: false };
  const used = (result.candidates ?? []).some((c) => (c.evidence ?? []).includes(`qr-untrusted:${w.detail}`));
  return { qrHost: w.detail ?? null, qrNumberUsed: used };
}

function persist(view) {
  if (windowId === null) return;
  saveLastResult(windowId, { ...view, imageHost: last.imageHost });
}

function setBody(state, { restored = false } = {}) {
  ui.setBodyState(state);
  if (restored) doc.body.dataset.restored = 'true'; else delete doc.body.dataset.restored;
}

// ---------------------------------------------------------------- scanning

async function startScan(input) {
  if (input.kind === 'page') { startPageScan(input.job); return; }
  current?.controller.abort();
  const controller = new AbortController();
  const id = crypto.randomUUID();
  const job = input.kind === 'job' ? input.job : null;
  current = { id, controller, input, job };
  const isCurrent = () => current?.id === id;
  if (job) rememberTab(job.tabId, job.pageUrl);
  revokePageThumbs();
  const d = describeInput(input);
  // The preview is a small copy made once the scanner has decoded the image (never the full photo, perf rec. 1).
  last = { ...blankLast(), input, job, thumbUrl: ui.thumbnail(null), thumbAlt: d.alt, caption: d.caption, imageHost: d.host };
  setBody('scanning');
  ui.showScanning({ caption: d.caption, thumbUrl: null, thumbAlt: d.alt });
  let thumbDone = Promise.resolve();
  const hints = job ? await tabTitle(job.tabId) : '';
  const result = await scan(input, {
    settings,
    hints,
    signal: controller.signal,
    onProgress: (p) => { if (isCurrent()) ui.progress(p.stage); },
    onImage: (blob, info) => {
      if (!isCurrent()) return;
      last.fullBlob = blob;
      thumbDone = makeThumbBlob(blob, info).then((small) => {
        if (!isCurrent() || !small) return;
        last.thumbUrl = ui.thumbnail(small);
        ui.updateScanThumb(last.thumbUrl, d.alt);
      });
    },
  });
  if (!isCurrent()) return; // superseded: newest trigger wins, stale results are discarded
  await thumbDone; // bounded by THUMB_TIMEOUT_MS
  if (!isCurrent()) return;
  current = null;
  last.result = result;
  await handleResult(result, autoOpenKey(input, id));
}

/** Confirm → Idle without opening anything (the read is dropped and not restored). */
function scanOther() {
  last = { ...blankLast(), thumbUrl: ui.thumbnail(null) };
  showIdleCard({ focus: true });
  if (windowId !== null) clearLastResult(windowId);
}

function showCancelled() {
  ui.thumbnail(null);
  showIdleCard({ focus: true });
  ui.announce(t('status_scan_cancelled'));
  if (windowId !== null) clearLastResult(windowId);
}

async function handleResult(result, openKey) {
  if (result.status === 'error') {
    if (result.error?.code === 'aborted') {
      showCancelled();
      return;
    }
    showErrorState(result.error?.code ?? 'engine-failed');
    return;
  }
  const { qrHost } = qrInfo(result);
  const offer = sharperOfferHost(result, declined);
  last.lowres = offer ? { host: offer, state: 'offer', origin: result.imageInfo.origin } : null;
  if (result.status === 'none') {
    setBody('none');
    ui.showNone({ thumbUrl: last.thumbUrl, thumbAlt: last.thumbAlt, qrHost, lowres: last.lowres, ocrUnavailable: result.warnings.some((w) => w.code === 'ocr-unavailable') });
    persist({ task: 'none', body: 'none', result, opened: null });
    return;
  }
  const top = result.candidates[0];
  // BGS read clearly: Beckett has no page per number, so nothing opens; the result (number + prices) shows at once
  // and "Open Beckett lookup" copies the number and opens the form.
  if (result.status === 'confirm' && top?.grader === 'bgs' && decide(result.candidates, settings, result.warnings ?? [], undefined, { lookupOk: true }) === 'auto-open') {
    showOpened({ grader: top.grader, number: top.number, method: top.source, url: buildCertUrl(top.grader, top.number), lookupPending: true }, 'opened');
    return;
  }
  // SEC-06: at most one automatic tab per context-menu job (a Sharper-scans re-run keeps the job id).
  if (result.status === 'auto-open' && !autoOpened.has(openKey)) {
    autoOpened.add(openKey);
    try {
      const r = await openCert(top, last.job, settings, { windowId });
      showOpened({ grader: top.grader, number: top.number, method: top.source, url: r.url, background: !r.active, tabId: r.tabId }, 'auto-open');
      return;
    } catch {
      showConfirmState(result, { openFailed: true });
      return;
    }
  }
  showConfirmState(result, {});
}

function showConfirmState(result, { openFailed = false, moveFocus = true, restored = false, backToPage = false } = {}) {
  const top = result.candidates[0];
  last.picked = top;
  setBody('confirm', { restored });
  const { qrHost, qrNumberUsed } = qrInfo(result);
  ui.showConfirm({
    result, candidates: result.candidates, reasons: confirmReasons(result, settings),
    thumbUrl: restored ? null : last.thumbUrl, thumbAlt: last.thumbAlt, caption: restored ? '' : last.caption,
    qrHost, qrNumberUsed, lowres: restored ? null : last.lowres,
    prefill: { number: top.number, grader: top.grader ?? top.graderOptions?.[0] ?? null }, backToPage,
  }, { moveFocus });
  if (openFailed) ui.showOpenError();
  if (!restored) persist({ task: 'confirm', body: 'confirm', result, opened: null });
}

function showOpened(opened, bodyState, { moveFocus = true, restored = false } = {}) {
  last.opened = opened;
  setBody(bodyState, { restored });
  ui.showResult({ opened, thumbUrl: restored ? null : last.thumbUrl, thumbAlt: last.thumbAlt, prices: pricesFor(opened) }, { moveFocus });
  if (!restored) persist({ task: 'result', body: bodyState, result: last.result, opened });
  refreshPrices();
}

// ---------------------------------------------------------------- prices in the panel

let psaToken = null;
let pptToken = null;
let priceRun = 0;
let lastPrices = null;

/**
 * Fill Value + Market: first the card from the cert (PSA API, when a key is saved), then the prices. Pokémon slabs with
 * a PokemonPriceTracker key: its eBay sales per grade (ADR A18); everything else, and Pokémon cards it doesn't know or
 * has no sales for in that grade: PriceCharting's price per grade and recent sales, read on this device.
 * fromCert=false keeps what the user typed.
 */
async function refreshPrices({ fromCert = true } = {}) {
  const o = last.opened;
  if (!o) return;
  const run = ++priceRun;
  let psa = null;
  if (fromCert && o.grader === 'psa' && psaToken) {
    ui.showPriceData({ status: 'loading' });
    const r = await fetchPsaCert(o.number, { token: psaToken }).catch(() => null);
    if (run !== priceRun) return;
    if (r?.ok) { psa = r.card; ui.applyCertCard(r.card); }
  }
  // Card name from the label itself, read at text size (the full-image pass reads it poorly on small photos, and a
  // QR/barcode read skips OCR altogether). Runs once per result, before the prices are looked up.
  if (fromCert && !psa && o.method !== 'manual' && last.fullBlob && last.labelFor !== o) {
    last.labelFor = o;
    ui.showPriceData({ status: 'reading' });
    const ok = (lines) => cardInfo({ grader: o.grader, number: o.number, lines }).desc !== null;
    const lines = await readLabel(last.fullBlob, { accept: ok, decimalGrade: o.grader !== 'psa' }).catch(() => []);
    if (run !== priceRun) return;
    const info = cardInfo({ grader: o.grader, number: o.number, lines });
    last.labelLines = lines;
    // Keep the scan's own reading when it has the card number and this pass lost it (small photos).
    const prev = ui.priceInput().desc;
    const better = info.desc && (cardNoFrom(info.desc) || !cardNoFrom(prev));
    if (better) ui.applyCertCard({ query: info.desc, grade: info.grade ?? ui.priceInput().grade, title: null });
    else if (info.grade && !ui.priceInput().grade) ui.applyCertCard({ query: '', grade: info.grade, title: null });
  }
  const { grader, desc, grade } = ui.priceInput();
  if (!desc) { ui.showPriceData({ status: 'need-card' }); return; }
  ui.showPriceData({ status: 'loading' });
  let res = null;
  let note = null;
  const pokemon = isPokemon({ lines: [...(last.result?.labelText ?? []), ...(last.labelLines ?? [])], desc, brand: psa?.brand ?? '' });
  try {
    let ppt = null;
    if (pptToken && pokemon && grader !== 'cgc-comics') {
      ppt = await loadPptPrices({ desc, cardNo: cardNoFrom(desc), grader, grade, token: pptToken });
      if (run !== priceRun) return;
      if (ppt.status === 'ok' && ppt.current) res = ppt;
      else if (['auth', 'limit', 'no-permission'].includes(ppt.status)) note = `prices_ppt_${ppt.status.replace('-', '_')}`;
    }
    if (!res) {
      const read = pricesFor(o);
      res = await loadPrices({ query: desc, cardNo: cardNoFrom(desc), grader, grade, special: grade === read.grade ? read.special : null });
      // PokemonPriceTracker knew the card but had no sale in this grade: its other grades beat an error.
      if (res.status !== 'ok' && ppt?.status === 'ok') res = ppt;
    }
  } catch { res = { status: 'error' }; }
  if (run !== priceRun) return;
  lastPrices = res;
  ui.showPriceData({ ...res, psa, note });
}

/** Price block for an opened cert: the card and grade read from the label (same photo only; empty for typed numbers). */
function pricesFor(opened) {
  const lines = opened.method === 'manual' ? null : last.result?.labelText;
  const { desc, grade } = cardInfo({ grader: opened.grader, number: opened.number, lines });
  const special = specialGrade(opened.grader, lines) ?? specialGrade(opened.grader, last.labelLines);
  return { grader: opened.grader, desc, grade, special, site: settings.ebaySite };
}

async function openPrice(makeUrl) {
  try {
    await openPriceLink(makeUrl(), last.job, settings, { windowId });
  } catch {
    ui.showOpenError();
  }
}

/**
 * Price block actions: allow/retry the in-panel prices, open the PriceCharting page that was read, eBay sold/for sale
 * for the card in the chosen grade ("... PSA 10"), the population report, and "This slab" (cert number) on eBay.
 */
function onPriceAction(a) {
  const o = last.opened;
  if (!o) return;
  if (a === 'price-allow') {
    // permissions.request must be the first call inside the click (user gesture).
    requestPricePermission().then((granted) => { if (granted) refreshPrices(); }, () => {});
    return;
  }
  if (a === 'price-retry') { refreshPrices({ fromCert: false }); return; }
  if (a === 'price-pc-open') {
    if (lastPrices?.url && isPcUrl(lastPrices.url)) openPrice(() => lastPrices.url);
    return;
  }
  if (a === 'price-pc-search') {
    // Opening PriceCharting in a normal tab also lets the browser pass PriceCharting's bot check; then "Try again".
    const { desc } = ui.priceInput();
    openPrice(() => (lastPrices?.url && isPcUrl(lastPrices.url) ? lastPrices.url : pcSearchUrl(desc || slabQuery(o.grader, o.number))));
    return;
  }
  if (a === 'price-pop') {
    if (POP_URLS[o.grader]) copyAndOpen(ui.priceInput().desc, POP_URLS[o.grader], 'prices_pop_copied');
    return;
  }
  if (a === 'price-slab') {
    const q = slabQuery(o.grader, o.number);
    if (q) openPrice(() => ebaySearchUrl(settings.ebaySite, q, { sold: true }));
    return;
  }
  const { grader, desc, grade } = ui.priceInput();
  const q = gradeQuery(grader, desc, grade);
  if (!q) { ui.showPriceError('prices_need_card'); return; }
  ui.showPriceError('');
  openPrice(() => ebaySearchUrl(settings.ebaySite, q, { sold: a === 'price-sold', single: true }));
}

/** Pages without a search link (population reports): copy the terms first (still inside the click), then open. */
async function copyAndOpen(text, url, copiedKey) {
  let copied = false;
  if (text) { try { await navigator.clipboard.writeText(text); copied = true; } catch { /* still open the page */ } }
  try {
    await openPriceLink(url, last.job, settings, { windowId });
    if (copied) ui.announce(t(copiedKey));
  } catch {
    ui.showOpenError();
  }
}

function canRetry(code) {
  if (!last.input) return false;
  if (last.input.kind === 'blob') return !['too-large', 'invalid-image', 'file-type'].includes(code);
  return true;
}

// ---------------------------------------------------------------- A9 page scan

/** Page job from the toolbar, the shortcut or the panel button: scan the page's slab photos. Newest job wins. */
async function startPageScan(job) {
  current?.controller.abort();
  const controller = new AbortController();
  const id = crypto.randomUUID();
  const input = { kind: 'page', job };
  current = { id, controller, input, job };
  const isCurrent = () => current?.id === id;
  rememberTab(job.tabId, job.pageUrl);
  revokePageThumbs();
  access = null;
  const host = hostOf(job.pageUrl);
  const caption = host ? t('image_source_page', [host]) : '';
  last = { ...blankLast(), input, job, thumbUrl: ui.thumbnail(null), caption, imageHost: host };
  setBody('scanning');
  ui.showScanning({ caption, page: true });
  const thumbs = [];
  const blobs = [];
  pageThumbs = thumbs;
  pageBlobs = blobs;
  const pending = [];
  let shownImage = -1;
  const result = await scanPage(job, {
    settings,
    signal: controller.signal,
    onProgress: (p) => { if (isCurrent()) ui.pageProgress(p); },
    onImageProgress: (_i, p) => { if (isCurrent()) ui.progress(p.stage); },
    onImage: (i, blob, info) => {
      if (!isCurrent()) return;
      blobs[i] = blob;
      shownImage = i;
      pending.push(makeThumbBlob(blob, info).then((small) => {
        // Only URLs created while this scan is current end up in pageThumbs (revoked with them).
        if (!isCurrent() || !small || pageThumbs !== thumbs) return;
        thumbs[i] = URL.createObjectURL(small);
        if (shownImage === i) ui.updateScanThumb(thumbs[i], t('page_result_photo', [String(i + 1)]));
      }));
    },
  });
  if (!isCurrent()) return; // superseded: newest trigger wins, stale results are discarded
  await Promise.all(pending); // each bounded by THUMB_TIMEOUT_MS
  if (!isCurrent()) return;
  current = null;
  await handlePageResult(result, autoOpenKey(input, id));
}

async function handlePageResult(result, openKey) {
  const job = last.job;
  if (result.status === 'error') {
    const code = pageErrorCode(result.error, job);
    if (code === 'aborted') showCancelled();
    else if (code === 'page-access') showAccessState(job.tabId);
    else if (code === 'page-no-access') showNoAccessError();
    else showErrorState(code);
    return;
  }
  last.page = { result, thumbs: pageThumbs, blobs: pageBlobs, opened: new Set(), ...pageQrInfo(result) };
  if (result.status === 'none') {
    setBody('none');
    ui.showPageNone({ discovered: result.discovered, reason: pageNoneReason(result), qrHost: last.page.qrHost });
    if (windowId !== null) clearLastResult(windowId); // a page "none" is not restored (A5 schema)
    return;
  }
  // SEC-06: at most one automatic tab per page job; a re-run of the same job shows the list instead.
  if (result.status === 'auto-open' && result.top && !autoOpened.has(openKey)) {
    autoOpened.add(openKey);
    const top = result.top;
    last.result = { status: 'auto-open', ...persistablePage(result), labelText: result.labels?.[top.imageIndex] };
    last.thumbUrl = pageThumbs[top.imageIndex] ?? null;
    last.fullBlob = pageBlobs[top.imageIndex] ?? null;
    last.thumbAlt = t('page_result_photo', [String(top.imageIndex + 1)]);
    try {
      const r = await openCert(top, job, settings, { windowId });
      last.page.opened.add(result.items.indexOf(top));
      showOpened({ grader: top.grader, number: top.number, method: top.source, url: r.url, background: !r.active, tabId: r.tabId }, 'auto-open');
    } catch {
      showPageResultsState({ openFailed: true });
    }
    return;
  }
  showPageResultsState();
}

function showPageResultsState({ openFailed = false, moveFocus = true } = {}) {
  const p = last.page;
  if (!p) return;
  last.result = p.result;
  setBody('page-results');
  ui.showPageResults({
    items: p.result.items, thumbs: p.thumbs, qrHost: p.qrHost, qrNumberUsed: p.qrNumberUsed,
    summary: pageSummary(p.result), opened: p.opened,
  }, { onOpen: openPageItem, onChoose: choosePageItem, onCopy: copyPageItem, onPrices: pricesPageItem }, { moveFocus });
  if (openFailed) ui.showOpenError();
  if (windowId !== null) clearLastResult(windowId); // results lists are not restored (they need the thumbnails)
}

async function openPageItem(item, i) {
  const p = last.page;
  try {
    await openCert({ grader: item.grader, number: item.number, source: item.source }, last.job, settings, { windowId });
    p?.opened.add(i);
    ui.markPageOpened(i);
    ui.announce(t(openedStatusKey(item.grader), [graderName(item.grader), item.number]));
  } catch {
    ui.showOpenError();
  }
}

/** "eBay sold" on a results row: sales of that card in that grade (read from its photo), else of that exact slab. */
async function pricesPageItem(item) {
  const { desc, grade } = cardInfo({ grader: item.grader, number: item.number, lines: last.page?.result.labels?.[item.imageIndex] });
  const card = desc ? gradeQuery(item.grader, desc, grade) : null;
  const q = card ?? slabQuery(item.grader, item.number);
  if (!q) return;
  try {
    await openPriceLink(ebaySearchUrl(settings.ebaySite, q, { sold: true, single: Boolean(card) }), last.job, settings, { windowId });
  } catch {
    ui.showOpenError();
  }
}

/** A listed number without a known grader: confirm it in S3 (grader radios), with a way back to the list. */
function choosePageItem(item) {
  const p = last.page;
  if (!p) return;
  const cand = { grader: item.grader, graderOptions: item.graderOptions, number: item.number, confidence: item.confidence, source: item.source, evidence: item.evidence };
  last.result = { status: 'confirm', candidates: [cand], warnings: p.result.warnings, imageInfo: null, labelText: p.result.labels?.[item.imageIndex] };
  last.thumbUrl = p.thumbs[item.imageIndex] ?? null;
  last.fullBlob = p.blobs?.[item.imageIndex] ?? null;
  last.thumbAlt = t('page_result_photo', [String(item.imageIndex + 1)]);
  last.lowres = null;
  showConfirmState(last.result, { backToPage: true });
}

async function copyPageItem(item) {
  try {
    await navigator.clipboard.writeText(item.number);
    ui.announce(t('status_copied'));
    if (item.grader && isValidCert(item.grader, item.number)) await recordHistory({ grader: item.grader, number: item.number, source: item.source }, last.job, settings);
  } catch {
    ui.announce(t('copy_failed'));
  }
}

/** Tab title of a right-clicked photo's page (readable through activeTab): a grader hint such as "... PSA 10". */
async function tabTitle(tabId) {
  try { return hintText((await chrome.tabs.get(tabId))?.title); } catch { return ''; }
}

/** Injected only to learn why a tab is unreadable (its error text); reads and changes nothing. */
function accessProbe() { return true; }

/**
 * Panel "Scan this page" (A9 trigger 3): works while CertScanner can read the active tab (live activeTab grant or a
 * host grant), which is exactly when tabs.query reveals its URL. Otherwise explain the icon/shortcut.
 */
let panelScanPending = false;
async function onPageScanButton() {
  if (windowId === null || panelScanPending) return; // no duplicate scans from a double click
  panelScanPending = true;
  try {
    await panelScan();
  } finally {
    panelScanPending = false;
  }
}

async function panelScan() {
  let tab = null;
  try { [tab] = await chrome.tabs.query({ active: true, windowId }); } catch { tab = null; }
  let plan = panelScanPlan(tab);
  if (plan.action === 'probe') {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', func: accessProbe });
      plan = { action: 'access' };
    } catch (e) {
      plan = panelScanPlan(tab, { injectError: String(e?.message ?? '') });
    }
  }
  if (plan.action === 'scan') {
    rememberTab(tab.id, tab.url);
    startPageScan(createPageJob(tab, Date.now(), crypto.randomUUID(), 'panel'));
    return;
  }
  current?.controller.abort();
  current = null;
  last = { ...blankLast(), thumbUrl: ui.thumbnail(null) };
  if (plan.action === 'restricted') showErrorState('restricted', { pageError: true });
  else showAccessState(tab?.id ?? null);
}

function showAccessState(tabId, { moveFocus = true } = {}) {
  const host = Number.isInteger(tabId) ? alwaysAllowHost(tabSites.get(tabId)) : null;
  access = { tabId, host };
  setBody('idle');
  ui.showPageAccess({ host, body: accessCopy() }, { moveFocus });
  if (windowId !== null) clearLastResult(windowId);
}

/** "Always allow on ‹host›": permissions.request is the first call in the click (user gesture); then scan. */
function onAlwaysAllow() {
  const a = access;
  if (!a?.host) return;
  requestSharper(`https://${a.host}`).then((granted) => {
    if (granted) {
      ui.announce(t('page_access_granted', [a.host]));
      onPageScanButton();
    } else {
      ui.setAccessOffer('denied', a.host);
      ui.announce(t('page_access_denied', [a.host]));
    }
  }, () => {
    ui.setAccessOffer('failed', a.host);
    ui.announce(t('perm_failed'));
  });
}

/**
 * O11 (E12): a toolbar/shortcut page job could not read its tab any more (e.g. it moved to another site right after
 * the click). Names the icon and the shortcut instead of the restricted-page text. Not restored after a reopen.
 */
function showNoAccessError({ moveFocus = true } = {}) {
  setBody('error');
  const ev = errorView('page-no-access', { page: true, body: noAccessCopy() });
  ui.showError(ev, { code: 'page-no-access', moveFocus });
  if (windowId !== null) clearLastResult(windowId);
}

function showErrorState(code, { moveFocus = true, restored = false, pageError = last.input?.kind === 'page' } = {}) {
  setBody('error', { restored });
  const ev = errorView(code, { retryable: !restored && canRetry(code), menuTitle: t('context_menu_scan'), page: !restored && pageError });
  ui.showError(ev, { code, moveFocus });
  if (!restored) persist({ task: 'error', body: 'error', result: null, error: { code }, opened: null });
}

/** Try again (A5): re-run the in-memory job while the activeTab grant still applies; else the upload path (E1). */
async function retry() {
  const input = last.input;
  if (!input) return;
  if (input.kind === 'page') {
    let ok = false;
    try {
      const tab = await chrome.tabs.get(input.job.tabId);
      ok = Boolean(tab?.url) && imageOriginOf(tab.url) === imageOriginOf(input.job.pageUrl);
    } catch { ok = false; }
    if (ok) startPageScan(input.job);
    else showAccessState(input.job.tabId);
    return;
  }
  if (input.kind === 'job') {
    let ok = false;
    try {
      const tab = await chrome.tabs.get(input.job.tabId);
      ok = Boolean(tab?.url) && imageOriginOf(tab.url) === imageOriginOf(input.job.pageUrl);
    } catch { ok = false; }
    if (!ok) { showErrorState('restricted'); return; }
  }
  startScan(input);
}

// ---------------------------------------------------------------- task card actions

async function onTaskFormSubmit() {
  const field = ui.field;
  if (!field) return;
  const v = field.submit();
  if (!v) return;
  const editing = ui.taskState === 'edit';
  // "Corrected by you" when editing a result or when the number is not one the scan read.
  const read = (last.result?.candidates ?? []).find((c) => c.number === v.number);
  const method = editing || !read ? 'edited' : read.source;
  const source = method === 'edited' ? 'manual' : method;
  try {
    const r = await openCert({ grader: v.grader, number: v.number, source }, last.job, settings, { windowId, replaceLatest: editing });
    showOpened({ grader: v.grader, number: v.number, method, url: r.url, background: !r.active, tabId: r.tabId }, 'opened');
  } catch {
    ui.showOpenError();
  }
}

async function copyNumber() {
  let number;
  let grader = null;
  let source = 'manual';
  if (ui.taskState === 'result' && last.opened) {
    ({ number, grader } = last.opened);
  } else if (ui.field) {
    const s = ui.field.selection();
    number = s.number;
    grader = s.grader;
    if (last.picked?.number === number) source = last.picked.source;
  }
  if (!/^\d{7,13}$/.test(number ?? '')) { ui.showCopyState(false); return; }
  try {
    await navigator.clipboard.writeText(number);
    ui.showCopyState(true);
    ui.announce(t('status_copied'));
    if (ui.taskState === 'confirm' && grader && isValidCert(grader, number)) await recordHistory({ grader, number, source }, last.job, settings);
  } catch {
    ui.showCopyState(false);
  }
}

async function openAgain() {
  const o = last.opened;
  if (!o) return;
  try {
    await openCert({ grader: o.grader, number: o.number, source: o.method === 'edited' ? 'manual' : o.method }, last.job, settings, { windowId });
    if (o.lookupPending) {
      // Beckett: the lookup is open now; Cert check updates in place and focus stays on the button (AC10).
      last.opened = { ...o, lookupPending: false };
      ui.markLookupOpened(last.opened);
      persist({ task: 'result', body: doc.body.dataset.state, result: last.result, opened: last.opened });
    }
    ui.announce(t(openedStatusKey(o.grader), [graderName(o.grader), o.number]));
  } catch {
    ui.showOpenError();
  }
}

function cancelEdit() {
  if (!last.opened) return;
  ui.showResult({ opened: last.opened, thumbUrl: last.thumbUrl, thumbAlt: last.thumbAlt, prices: pricesFor(last.opened) }, { moveFocus: false });
  refreshPrices();
  doc.querySelector('#task [data-action="edit"]')?.focus();
}

function focusCertInput() {
  ui.openOtherWays();
  const input = $('cert-input');
  input.scrollIntoView({ block: 'center' });
  input.focus();
}

$('task').addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-action]');
  if (!b) return;
  const a = b.dataset.action;
  if (a === 'cancel') current?.controller.abort();
  else if (a === 'choose') $('file-input').click();
  else if (a === 'type') focusCertInput();
  else if (a === 'retry') retry();
  else if (a === 'reload') location.reload();
  else if (a === 'copy') copyNumber();
  else if (a === 'open-again') openAgain();
  else if (a === 'edit') ui.showEdit({ number: last.opened.number, grader: last.opened.grader });
  else if (a === 'edit-cancel') cancelEdit();
  else if (a === 'go-to-tab' && Number.isInteger(last.opened?.tabId)) chrome.tabs.update(last.opened.tabId, { active: true }).catch(() => ui.showOpenError());
  else if (a === 'larger') ui.toggleLarger(last.fullBlob);
  else if (a === 'sharper') onSharper();
  else if (a === 'not-now') onNotNow();
  else if (a === 'rescan') { if (last.input) startScan(last.input); }
  else if (a === 'page-scan') onPageScanButton();
  else if (a === 'always-allow') onAlwaysAllow();
  else if (a === 'back-to-page') showPageResultsState();
  else if (a === 'scan-other') scanOther();
  else if (a.startsWith('price-')) onPriceAction(a);
});
$('choose-image').addEventListener('click', () => $('file-input').click());

// ---------------------------------------------------------------- N1 sharper scans

async function rememberDeclined(host) {
  declined.add(host);
  try { await chrome.storage.session.set({ [DECLINED_KEY]: [...declined].slice(-50) }); } catch { /* best effort */ }
}

function rerenderLowres(next, focusTarget) {
  last.lowres = next;
  const r = last.result;
  if (!r) return;
  // Re-render only the notice; the rest of the card (and any edits in the field) stays.
  const slot = doc.querySelector('#task [data-ref="lowres-slot"]');
  if (!slot) return;
  while (slot.firstChild) slot.firstChild.remove();
  if (next) ui.renderLowres(slot, next);
  ui.lowresFocus(focusTarget);
}

function onSharper() {
  const lr = last.lowres;
  if (!lr) return;
  // permissions.request must be the first call inside the click (user gesture).
  requestSharper(lr.origin).then((granted) => {
    if (granted) {
      rerenderLowres({ ...lr, state: 'granted', primary: ui.taskState === 'none' }, 'rescan');
      ui.announce(t('perm_granted', [lr.host]));
    } else {
      rememberDeclined(lr.host);
      rerenderLowres({ ...lr, state: 'denied' }, 'box');
      ui.announce(t('perm_denied', [lr.host]));
    }
  }, () => {
    rerenderLowres({ ...lr, state: 'failed' }, 'box');
    ui.announce(t('perm_failed'));
  });
}

function onNotNow() {
  if (last.lowres) rememberDeclined(last.lowres.host);
  rerenderLowres(null, 'heading');
}

// ---------------------------------------------------------------- manual entry (§4)

const manualField = createCertField({
  input: $('cert-input'), fieldset: $('grader-group'), errorEl: $('cert-error'), previewEl: $('url-preview'),
  hintEl: $('manual-grader-hint'), radioName: 'manual-grader', autoHide: true,
});
$('manual-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = manualField.submit();
  if (!v) return;
  current?.controller.abort();
  current = null;
  try {
    const r = await openCert({ grader: v.grader, number: v.number, source: 'manual' }, null, settings, { windowId });
    manualField.reset();
    // The form collapses with "Other ways to scan" in the result: focus moves to the result heading (QA P2-4).
    if (doc.activeElement instanceof HTMLElement) doc.activeElement.blur();
    last = { ...blankLast(), thumbUrl: ui.thumbnail(null) };
    showOpened({ grader: v.grader, number: v.number, method: 'manual', url: r.url, background: !r.active, tabId: r.tabId }, 'opened');
  } catch {
    $('cert-error').textContent = t('err_open_tab');
  }
});

// ---------------------------------------------------------------- recent

function renderRecent() {
  ui.renderRecent(history.entries, {
    historyOn: settings.saveHistory,
    locale: t('locale_code'),
    onOpen: async (entry) => {
      try {
        const r = await openCert({ grader: entry.grader, number: entry.number, source: entry.source }, null, settings, { windowId });
        last = { ...blankLast(), thumbUrl: ui.thumbnail(null) };
        showOpened({ grader: entry.grader, number: entry.number, method: entry.source, url: r.url, background: !r.active, tabId: r.tabId }, 'opened', { moveFocus: false });
      } catch {
        ui.announce(t('err_open_tab'));
      }
    },
    onCopy: async (entry) => {
      try {
        await navigator.clipboard.writeText(entry.number);
        ui.announce(t('status_copied'));
      } catch {
        ui.announce(t('copy_failed'));
      }
    },
  });
  ui.renderSettings(settings, { historyCount: history.entries.length });
}
$('recent-toggle').addEventListener('click', () => { ui.toggleRecent(); renderRecent(); });

// ---------------------------------------------------------------- settings view (V2)

function showView(name) {
  const settingsView = name === 'settings';
  $('home').hidden = settingsView;
  $('settings').hidden = !settingsView;
  $('settings-button').hidden = settingsView;
  inputs.clearDrag();
  if (settingsView) {
    refreshSites();
    refreshShortcut();
    $('settings-heading').focus();
  } else {
    $('settings-button').focus();
  }
}
$('settings-button').addEventListener('click', () => showView('settings'));
// Extensions can't link to chrome:// pages, but tabs.create may open the shortcut editor.
$('shortcut-button').addEventListener('click', () => { chrome.tabs.create({ url: SHORTCUTS_URL }).catch(() => ui.announce(t('err_open_tab'))); });
$('back-button').addEventListener('click', () => showView('home'));

// PSA API key (optional): card name and population from the cert number. Saving asks for api.psacard.com access.
function renderPsaKey(status = null) {
  $('psa-key-remove').hidden = !psaToken;
  $('psa-key-status').textContent = status ? t(status) : (psaToken ? t('setting_psa_key_saved') : '');
}
$('psa-key-save').addEventListener('click', () => {
  const v = $('setting-psa-key').value.trim();
  if (!isPsaToken(v)) { renderPsaKey('setting_psa_key_invalid'); return; }
  chrome.permissions.request({ origins: [PSA_API_PERMISSION] }).then(async (granted) => {
    if (!granted) { renderPsaKey('setting_psa_key_denied'); return; }
    await savePsaToken(v);
    psaToken = v;
    $('setting-psa-key').value = '';
    renderPsaKey('setting_psa_key_saved');
  }, () => renderPsaKey('setting_psa_key_denied'));
});
$('psa-key-remove').addEventListener('click', async () => {
  await clearPsaToken().catch(() => {});
  chrome.permissions.remove({ origins: [PSA_API_PERMISSION] }).catch(() => {}); // the key was the only reason for it
  psaToken = null;
  renderPsaKey('setting_psa_key_removed');
});
// PokemonPriceTracker API key (optional): Pokémon prices from eBay sales per grade. Saving asks for its host access.
function renderPptKey(status = null) {
  $('ppt-key-remove').hidden = !pptToken;
  $('ppt-key-status').textContent = status ? t(status) : (pptToken ? t('setting_ppt_key_saved') : '');
}
$('ppt-key-save').addEventListener('click', () => {
  const v = $('setting-ppt-key').value.trim();
  if (!isPptToken(v)) { renderPptKey('setting_ppt_key_invalid'); return; }
  chrome.permissions.request({ origins: [PPT_PERMISSION] }).then(async (granted) => {
    if (!granted) { renderPptKey('setting_ppt_key_denied'); return; }
    await savePptToken(v);
    pptToken = v;
    $('setting-ppt-key').value = '';
    renderPptKey('setting_ppt_key_saved');
  }, () => renderPptKey('setting_ppt_key_denied'));
});
$('ppt-key-remove').addEventListener('click', async () => {
  await clearPptToken().catch(() => {});
  chrome.permissions.remove({ origins: [PPT_PERMISSION] }).catch(() => {}); // the key was the only reason for it
  pptToken = null;
  renderPptKey('setting_ppt_key_removed');
});
$('ppt-key-get').addEventListener('click', () => { chrome.tabs.create({ url: PPT_SIGNUP }).catch(() => ui.announce(t('err_open_tab'))); });
$('psa-key-get').addEventListener('click', () => { chrome.tabs.create({ url: PSA_API_SIGNUP }).catch(() => ui.announce(t('err_open_tab'))); });

$('setting-ebay-site').addEventListener('change', async (e) => {
  try {
    settings = await saveSettings({ ebaySite: e.target.value });
  } catch {
    ui.renderSettings(settings, { historyCount: history.entries.length }); // revert the choice
  }
});

for (const box of doc.querySelectorAll('[data-setting]')) {
  box.addEventListener('change', async () => {
    const key = box.dataset.setting;
    const value = box.dataset.inverted === 'true' ? !box.checked : box.checked;
    try {
      settings = await saveSettings({ [key]: value });
      if (key === 'saveHistory' && !value) {
        await clearHistory().catch(() => {});
        await clearAllLastResults(); // SEC-18: no cert number survives in a restorable last result either
        history = { v: 1, entries: [] };
        ui.announce(t('status_history_cleared'));
      }
      renderRecent();
    } catch {
      ui.renderSettings(settings, { historyCount: history.entries.length }); // revert the switch
    }
  });
}

$('clear-history').addEventListener('click', async () => {
  if ($('clear-history').getAttribute('aria-disabled') === 'true') return;
  await clearHistory().catch(() => {});
  await clearAllLastResults(); // SEC-18
  history = { v: 1, entries: [] };
  renderRecent();
  ui.announce(t('status_history_cleared'));
  // Focus stays on the button (now aria-disabled with "No saved scans.").
});

async function refreshSites({ focusAfterRemove = null } = {}) {
  let granted = { hosts: [], allSites: [] };
  try { granted = await listGrantedSites(chrome, { exclude: [PSA_API_PERMISSION, PPT_PERMISSION] }); } catch { /* keep empty */ }
  ui.renderSites(granted, {
    // SEC-17: announce what Chrome actually did (remove() resolves false when nothing was removed).
    onRemove: async (host, index) => {
      const s = removalStatus(await removeSite(host).catch(() => false), host);
      ui.announce(t(s.key, s.subs));
      $('sites-error').textContent = s.key === 'status_site_not_removed' ? t(s.key, s.subs) : '';
      refreshSites({ focusAfterRemove: index });
    },
    onRemoveAll: async () => {
      const s = removalStatus(await removeAllSites(granted.allSites), t('settings_sites_all'));
      ui.announce(t(s.key, s.subs));
      $('sites-error').textContent = s.key === 'status_site_not_removed' ? t(s.key, s.subs) : '';
      refreshSites({ focusAfterRemove: 0 });
    },
  });
  if (focusAfterRemove !== null) {
    const buttons = [...doc.querySelectorAll('#sites-list button')];
    (buttons[focusAfterRemove] ?? buttons[buttons.length - 1] ?? $('sites-heading')).focus();
  }
}

// ---------------------------------------------------------------- keyboard + inputs

const inputs = wireInputs({
  doc, home: $('home'), fileInput: $('file-input'), certInput: $('cert-input'), dropTitle: $('drop-title'),
  texts: { idle: t('drop_title'), active: t('drop_active') },
  isHomeActive: () => !$('home').hidden,
  onFile: (file, method) => startScan({ kind: 'blob', blob: file, method }),
  onError: (code) => {
    current?.controller.abort();
    current = null;
    last = { ...blankLast(), thumbUrl: ui.thumbnail(null) };
    showErrorState(code);
  },
});

doc.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (inputs.dragging) { inputs.clearDrag(); return; }
  if (!$('settings').hidden) { e.preventDefault(); showView('home'); return; }
  if (current) { e.preventDefault(); current.controller.abort(); return; }
  if (ui.taskState === 'edit') { e.preventDefault(); cancelEdit(); return; }
  if (ui.taskState === 'confirm' && doc.activeElement?.id !== 'cert-input') { e.preventDefault(); scanOther(); }
});

window.addEventListener('online', () => doc.querySelectorAll('#task [data-ref="offline"]').forEach((el) => { el.hidden = true; }));
window.addEventListener('offline', () => doc.querySelectorAll('#task [data-ref="offline"]').forEach((el) => { el.hidden = false; }));
window.addEventListener('pagehide', () => {
  current?.controller.abort();
  revokePageThumbs();
  disposeEngines();
});
// chrome.commands has no change event: re-read the shortcut when the user comes back to the panel.
window.addEventListener('focus', () => { refreshShortcut(); });
doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') refreshShortcut(); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!tabSites.has(tabId)) return;
  if (typeof info.url === 'string' && info.url) tabSites.set(tabId, info.url);
  else if (info.status === 'loading' || 'url' in info) tabSites.delete(tabId); // navigated where the panel can't see
});
chrome.tabs.onRemoved.addListener((tabId) => { tabSites.delete(tabId); });

// ---------------------------------------------------------------- bootstrap

function restore(saved) {
  last = { ...blankLast(), imageHost: saved.imageHost };
  const result = { status: saved.body, candidates: saved.candidates.map((c) => ({ ...c, evidence: [] })), warnings: saved.warnings, imageInfo: saved.resolution ? { resolution: saved.resolution } : null };
  last.result = result;
  if (saved.task === 'result' && saved.opened) {
    showOpened({ ...saved.opened, url: buildCertUrl(saved.opened.grader, saved.opened.number), tabId: null }, saved.body, { moveFocus: false, restored: true });
  } else if (saved.task === 'confirm') {
    showConfirmState(result, { moveFocus: false, restored: true });
  } else if (saved.task === 'none') {
    setBody('none', { restored: true });
    ui.showNone({ thumbUrl: null, qrHost: qrInfo(result).qrHost, lowres: null, ocrUnavailable: saved.warnings.some((w) => w.code === 'ocr-unavailable') }, { moveFocus: false });
  } else if (saved.task === 'error' && saved.error) {
    showErrorState(saved.error.code, { moveFocus: false, restored: true });
  }
}

(async () => {
  try { settings = await loadSettings(); } catch { settings = { ...DEFAULT_SETTINGS }; }
  psaToken = await loadPsaToken();
  renderPsaKey();
  pptToken = await loadPptToken();
  renderPptKey();
  try { history = await loadHistory(); } catch { history = { v: 1, entries: [] }; }
  renderRecent();
  refreshShortcut();
  onSettingsChanged((s) => {
    settings = s;
    renderRecent();
    ui.updateIdleHint(idleHint());
    ui.updateAccessBody(accessCopy());
    ui.updateNoAccessBody(noAccessCopy());
  });
  onHistoryChanged((h) => { history = h; renderRecent(); });
  onPermissionsChanged(() => { if (!$('settings').hidden) refreshSites(); });
  try {
    const got = await chrome.storage.session.get(DECLINED_KEY);
    for (const h of got?.[DECLINED_KEY] ?? []) if (typeof h === 'string') declined.add(h);
  } catch { /* none */ }

  windowId = await resolveTargetWindowId(location.search);
  doc.body.dataset.windowId = String(windowId);
  const saved = await loadLastResult(windowId);
  if (saved && !current) restore(saved);
  // A9: page jobs (toolbar icon, shortcut) and image jobs (context menu) share the slot; newest job wins.
  startJobIntake({ windowId, onJob: (job) => (job.kind === 'page' ? startPageScan(job) : startScan({ kind: 'job', job })) });
  doc.body.dataset.ready = '1';
})();
