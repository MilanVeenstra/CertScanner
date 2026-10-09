// Side-panel bootstrap and state flow (UX spec §3; ADR §4, §13, A4, A5).
// body[data-state] keeps the §13 values (+ 'opened'); the finer task-card state lives on section#task[data-state].
import { applyI18n, t } from '../shared/i18n.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, onSettingsChanged } from '../shared/settings.js';
import { loadHistory, clearHistory, onHistoryChanged, MAX_HISTORY } from '../shared/history.js';
import { saveLastResult, loadLastResult, clearLastResult } from '../shared/lastResult.js';
import { buildCertUrl, isValidCert } from '../core/certUrls.js';
import { scan, disposeEngines } from '../pipeline/scanner.js';
import { imageOriginOf } from '../pipeline/acquire.js';
import { createUi, graderName } from './ui.js';
import { createCertField } from './certField.js';
import { confirmReasons, errorView, sharperOfferHost, MAX_IMAGE_MB } from './viewModel.js';
import { resolveTargetWindowId, startJobIntake } from './jobIntake.js';
import { openCert, recordHistory } from './opener.js';
import { wireInputs } from './inputs.js';
import { requestSharper, listGrantedSites, removeSite, onPermissionsChanged } from './permissionsUi.js';

const DECLINED_KEY = 'sharperDeclined';
const doc = document;
const $ = (id) => doc.getElementById(id);

applyI18n(doc);

let settings = { ...DEFAULT_SETTINGS };
let windowId = null;
let history = { v: 1, entries: [] };
/** In-flight scan. */
let current = null;
/** Last completed scan context: what Try again / Scan again / Copy / Edit act on. */
let last = { input: null, job: null, result: null, opened: null, thumbUrl: null, thumbAlt: '', caption: '', imageHost: null, picked: null, lowres: null };
const autoOpened = new Set();
const declined = new Set(); // hosts where "Sharper scans" was denied or dismissed this session

const ui = createUi(doc, {
  submitTaskForm: () => onTaskFormSubmit(),
  candidatePicked: (c) => { last.picked = c; },
});

// ---------------------------------------------------------------- static texts with substitutions
const isMac = /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
$('paste-hint').textContent = t('paste_hint', [t(isMac ? 'shortcut_paste_mac' : 'shortcut_paste_other')]);
$('drop-formats').textContent = t('drop_formats', [t('size_mb', [String(MAX_IMAGE_MB)])]);
$('hint-history').textContent = t('setting_history_hint', [String(MAX_HISTORY)]);
$('about-version').textContent = t('about_version', [chrome.runtime.getManifest().version]);
ui.showIdle();

// ---------------------------------------------------------------- helpers
const hostOf = (url) => { try { return new URL(url).hostname || null; } catch { return null; } };

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
  current?.controller.abort();
  const controller = new AbortController();
  const id = crypto.randomUUID();
  const job = input.kind === 'job' ? input.job : null;
  current = { id, controller, input, job };
  const isCurrent = () => current?.id === id;
  const d = describeInput(input);
  const thumbUrl = input.kind === 'blob' ? ui.thumbnail(input.blob) : ui.thumbnail(null);
  last = { input, job, result: null, opened: null, thumbUrl, thumbAlt: d.alt, caption: d.caption, imageHost: d.host, picked: null, lowres: null };
  setBody('scanning');
  ui.showScanning({ caption: d.caption, thumbUrl, thumbAlt: d.alt });
  const result = await scan(input, {
    settings,
    signal: controller.signal,
    onProgress: (p) => { if (isCurrent()) ui.progress(p.stage); },
    onImage: (blob) => {
      if (!isCurrent() || input.kind !== 'job') return;
      last.thumbUrl = ui.thumbnail(blob);
      ui.updateScanThumb(last.thumbUrl, d.alt);
    },
  });
  if (!isCurrent()) return; // superseded: newest trigger wins, stale results are discarded
  current = null;
  last.result = result;
  await handleResult(result, id);
}

async function handleResult(result, scanId) {
  if (result.status === 'error') {
    if (result.error?.code === 'aborted') {
      setBody('idle');
      ui.thumbnail(null);
      ui.showIdle({ focus: true });
      ui.announce(t('status_scan_cancelled'));
      if (windowId !== null) clearLastResult(windowId);
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
  if (result.status === 'auto-open' && !autoOpened.has(scanId)) {
    autoOpened.add(scanId);
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

function showConfirmState(result, { openFailed = false, moveFocus = true, restored = false } = {}) {
  const top = result.candidates[0];
  last.picked = top;
  setBody('confirm', { restored });
  const { qrHost, qrNumberUsed } = qrInfo(result);
  ui.showConfirm({
    result, candidates: result.candidates, reasons: confirmReasons(result, settings),
    thumbUrl: restored ? null : last.thumbUrl, thumbAlt: last.thumbAlt, caption: restored ? '' : last.caption,
    qrHost, qrNumberUsed, lowres: restored ? null : last.lowres,
    prefill: { number: top.number, grader: top.grader },
  }, { moveFocus });
  if (openFailed) ui.showOpenError();
  if (!restored) persist({ task: 'confirm', body: 'confirm', result, opened: null });
}

function showOpened(opened, bodyState, { moveFocus = true, restored = false } = {}) {
  last.opened = opened;
  setBody(bodyState, { restored });
  ui.showResult({ opened, thumbUrl: restored ? null : last.thumbUrl, thumbAlt: last.thumbAlt }, { moveFocus });
  if (!restored) persist({ task: 'result', body: bodyState, result: last.result, opened });
}

function canRetry(code) {
  if (!last.input) return false;
  if (last.input.kind === 'blob') return !['too-large', 'invalid-image', 'file-type'].includes(code);
  return true;
}

function showErrorState(code, { moveFocus = true, restored = false } = {}) {
  setBody('error', { restored });
  const ev = errorView(code, { retryable: !restored && canRetry(code), menuTitle: t('context_menu_scan') });
  ui.showError(ev, { code, moveFocus });
  if (!restored) persist({ task: 'error', body: 'error', result: null, error: { code }, opened: null });
}

/** Try again (A5): re-run the in-memory job while the activeTab grant still applies; else the upload path (E1). */
async function retry() {
  const input = last.input;
  if (!input) return;
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

async function copyNumber(button) {
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
  if (!/^\d{7,13}$/.test(number ?? '')) { ui.showCopyState(button, false); return; }
  try {
    await navigator.clipboard.writeText(number);
    ui.showCopyState(button, true);
    ui.announce(t('status_copied'));
    if (ui.taskState === 'confirm' && grader && isValidCert(grader, number)) await recordHistory({ grader, number, source }, last.job, settings);
  } catch {
    ui.showCopyState(button, false);
  }
}

async function openAgain() {
  const o = last.opened;
  if (!o) return;
  try {
    await openCert({ grader: o.grader, number: o.number, source: o.method === 'edited' ? 'manual' : o.method }, last.job, settings, { windowId });
    ui.announce(t('status_opened', [graderName(o.grader), o.number]));
  } catch {
    ui.showOpenError();
  }
}

function cancelEdit() {
  if (!last.opened) return;
  ui.showResult({ opened: last.opened, thumbUrl: last.thumbUrl, thumbAlt: last.thumbAlt }, { moveFocus: false });
  doc.querySelector('#task [data-action="edit"]')?.focus();
}

function focusCertInput() {
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
  else if (a === 'copy') copyNumber(b);
  else if (a === 'open-again') openAgain();
  else if (a === 'edit') ui.showEdit({ number: last.opened.number, grader: last.opened.grader });
  else if (a === 'edit-cancel') cancelEdit();
  else if (a === 'go-to-tab' && Number.isInteger(last.opened?.tabId)) chrome.tabs.update(last.opened.tabId, { active: true }).catch(() => ui.showOpenError());
  else if (a === 'larger') ui.toggleLarger();
  else if (a === 'sharper') onSharper();
  else if (a === 'not-now') onNotNow();
  else if (a === 'rescan') { if (last.input) startScan(last.input); }
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
  hintEl: $('manual-grader-hint'), radioName: 'manual-grader',
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
    $('cert-input').focus(); // F5: focus stays in the cleared input
    last = { input: null, job: null, result: null, opened: null, thumbUrl: ui.thumbnail(null), thumbAlt: '', caption: '', imageHost: null, picked: null, lowres: null };
    showOpened({ grader: v.grader, number: v.number, method: 'manual', url: r.url, background: !r.active, tabId: r.tabId }, 'opened', { moveFocus: false });
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
        last = { input: null, job: null, result: null, opened: null, thumbUrl: ui.thumbnail(null), thumbAlt: '', caption: '', imageHost: null, picked: null, lowres: null };
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
    $('settings-heading').focus();
  } else {
    $('settings-button').focus();
  }
}
$('settings-button').addEventListener('click', () => showView('settings'));
$('back-button').addEventListener('click', () => showView('home'));

for (const box of doc.querySelectorAll('[data-setting]')) {
  box.addEventListener('change', async () => {
    const key = box.dataset.setting;
    const value = box.dataset.inverted === 'true' ? !box.checked : box.checked;
    try {
      settings = await saveSettings({ [key]: value });
      if (key === 'saveHistory' && !value) {
        await clearHistory().catch(() => {});
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
  history = { v: 1, entries: [] };
  renderRecent();
  ui.announce(t('status_history_cleared'));
  // Focus stays on the button (now aria-disabled with "No saved scans.").
});

async function refreshSites({ focusAfterRemove = null } = {}) {
  let hosts = [];
  try { hosts = await listGrantedSites(); } catch { hosts = []; }
  ui.renderSites(hosts, async (host, index) => {
    await removeSite(host).catch(() => false);
    ui.announce(t('status_site_removed', [host]));
    refreshSites({ focusAfterRemove: index });
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
    last = { input: null, job: null, result: null, opened: null, thumbUrl: ui.thumbnail(null), thumbAlt: '', caption: '', imageHost: null, picked: null, lowres: null };
    showErrorState(code);
  },
});

doc.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (inputs.dragging) { inputs.clearDrag(); return; }
  if (!$('settings').hidden) { e.preventDefault(); showView('home'); return; }
  if (current) { e.preventDefault(); current.controller.abort(); return; }
  if (ui.taskState === 'edit') { e.preventDefault(); cancelEdit(); }
});

window.addEventListener('online', () => doc.querySelectorAll('#task [data-ref="offline"]').forEach((el) => { el.hidden = true; }));
window.addEventListener('offline', () => doc.querySelectorAll('#task [data-ref="offline"]').forEach((el) => { el.hidden = false; }));
window.addEventListener('pagehide', () => {
  current?.controller.abort();
  disposeEngines();
});

// ---------------------------------------------------------------- bootstrap

function restore(saved) {
  last = { input: null, job: null, result: null, opened: null, thumbUrl: null, thumbAlt: '', caption: '', imageHost: saved.imageHost, picked: null, lowres: null };
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
  try { history = await loadHistory(); } catch { history = { v: 1, entries: [] }; }
  renderRecent();
  onSettingsChanged((s) => { settings = s; renderRecent(); });
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
  startJobIntake({ windowId, onJob: (job) => startScan({ kind: 'job', job }) });
  doc.body.dataset.ready = '1';
})();
