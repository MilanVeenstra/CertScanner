// Side-panel bootstrap (ADR-001 §12): target window, job intake, scan lifecycle, wiring.
import { applyI18n, t } from '../shared/i18n.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, onSettingsChanged } from '../shared/settings.js';
import { loadHistory, clearHistory, onHistoryChanged } from '../shared/history.js';
import { isValidCert } from '../core/certUrls.js';
import { parseManualEntry } from '../core/manualEntry.js';
import { scan, disposeEngines } from '../pipeline/scanner.js';
import { createUi, graderLabel } from './ui.js';
import { resolveTargetWindowId, startJobIntake } from './jobIntake.js';
import { openCert, recordHistory } from './opener.js';
import { wireInputs } from './inputs.js';
import { requestSharper, listGrantedSites, removeSite, onPermissionsChanged } from './permissionsUi.js';

const MANUAL_ERROR_KEYS = {
  empty: 'errorManualEmpty', 'too-long': 'errorManualTooLong', 'no-number': 'errorManualNoNumber',
  'bad-length': 'errorManualBadLength', invalid: 'errorManualInvalid', 'untrusted-url': 'errorManualUntrustedUrl',
};

applyI18n(document);
const ui = createUi(document);
ui.setState('idle');
ui.announce(t('stateIdle'));

let settings = { ...DEFAULT_SETTINGS };
let windowId = null;
/** @type {{id:string, controller:AbortController, input:any, job:any} | null} */
let current = null;
/** Last finished scan: what the confirm form, copy and "Sharper scans" act on. */
let last = { result: null, job: null, input: null };
const autoOpened = new Set();

// ---------------------------------------------------------------- scanning

async function startScan(input, { fromPanel = false } = {}) {
  current?.controller.abort();
  const controller = new AbortController();
  const id = crypto.randomUUID();
  const job = input.kind === 'job' ? input.job : null;
  current = { id, controller, input, job };
  const isCurrent = () => current?.id === id;
  ui.beginScan();
  const result = await scan(input, {
    settings,
    signal: controller.signal,
    onProgress: (p) => { if (isCurrent()) ui.showProgress(p); },
    onImage: (blob) => { if (isCurrent()) ui.setPreview(blob); },
  });
  if (!isCurrent()) return; // superseded: newest job wins, stale results are discarded
  current = null;
  last = { result, job, input };
  await handleResult(result, job, id, fromPanel);
}

async function handleResult(result, job, scanId, fromPanel) {
  if (result.status === 'error') {
    if (result.error?.code === 'aborted') {
      ui.setState('idle');
      ui.announce(t('stateCancelled'));
      return;
    }
    ui.setState('error');
    ui.showError(result.error?.code, { canRequestSharper: result.error?.canRequestSharper, origin: result.error?.origin ?? null });
    ui.announce(ui.el.errorMessage.textContent);
    return;
  }
  ui.showResult(result);
  if (result.imageInfo?.canRequestSharper && result.imageInfo.origin) ui.showSharper(result.imageInfo.origin);
  if (result.status === 'none') {
    ui.setState('none');
    ui.announce(t('stateNone'));
    if (fromPanel) ui.focusResult();
    return;
  }
  const top = result.candidates[0];
  if (result.status === 'auto-open' && !autoOpened.has(scanId)) {
    autoOpened.add(scanId);
    try {
      await openCert(top, job, settings, { windowId });
      ui.setState('auto-open');
      ui.announce(t('stateAutoOpen', [graderLabel(top.grader), top.number]));
      return;
    } catch {
      ui.fieldError(t('errorOpenFailed'));
    }
  }
  ui.setState('confirm');
  ui.announce(top.grader ? t('stateConfirm') : t('stateConfirmGrader'));
  ui.focusResult();
}

// ---------------------------------------------------------------- confirm form

function currentChoice() {
  const { grader, number } = ui.selection();
  if (!grader) { ui.fieldError(t('errorChooseGrader')); ui.el.graderSelect.focus(); return null; }
  if (!isValidCert(grader, number)) { ui.fieldError(t('errorBadNumber')); ui.el.numberInput.focus(); return null; }
  ui.fieldError('');
  const picked = ui.candidates.find((c) => c.number === number);
  return { grader, number, source: picked ? picked.source : 'manual' };
}

document.getElementById('confirm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const choice = currentChoice();
  if (!choice) return;
  try {
    await openCert(choice, last.job, settings, { windowId });
    ui.setState('opened');
    ui.announce(t('stateOpened', [graderLabel(choice.grader), choice.number]));
  } catch {
    ui.fieldError(t('errorOpenFailed'));
  }
});

ui.el.copyButton.addEventListener('click', async () => {
  const { grader, number } = ui.selection();
  if (!/^\d{7,13}$/.test(number)) { ui.fieldError(t('errorBadNumber')); return; }
  try {
    await navigator.clipboard.writeText(number);
    ui.announce(t('stateCopied', [number]));
    if (grader && isValidCert(grader, number)) {
      const picked = ui.candidates.find((c) => c.number === number);
      await recordHistory({ grader, number, source: picked ? picked.source : 'manual' }, last.job, settings);
    }
  } catch {
    ui.fieldError(t('errorCopyFailed'));
  }
});

ui.el.candidateList.addEventListener('click', (e) => {
  const b = e.target.closest?.('button[data-index]');
  if (b) ui.selectCandidate(Number(b.dataset.index));
});

ui.el.cancel.addEventListener('click', () => current?.controller.abort());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current) { e.preventDefault(); current.controller.abort(); }
});

// ---------------------------------------------------------------- sharper scans

ui.el.sharper.addEventListener('click', () => {
  const origin = ui.el.sharper.dataset.origin;
  // permissions.request must be the first call in the gesture.
  requestSharper(origin).then((granted) => {
    if (!granted) { ui.announce(t('errorPermissionDenied')); return; }
    ui.el.sharper.hidden = true;
    if (last.input?.kind === 'job') startScan(last.input, { fromPanel: true });
  });
});

async function refreshSites() {
  try {
    ui.renderSites(await listGrantedSites(), async (host) => {
      await removeSite(host).catch(() => false);
      ui.settingsStatus(t('settingsSiteRemoved', [host]));
      refreshSites();
    });
  } catch { /* permissions API unavailable */ }
}

// ---------------------------------------------------------------- manual entry

const manualInput = document.getElementById('manual-input');
const manualError = document.getElementById('manual-error');
document.getElementById('manual-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = parseManualEntry(manualInput.value);
  if (!r.ok) {
    manualError.textContent = t(MANUAL_ERROR_KEYS[r.error] ?? 'errorManualInvalid');
    manualInput.setAttribute('aria-invalid', 'true');
    manualInput.focus();
    return;
  }
  manualError.textContent = '';
  manualInput.removeAttribute('aria-invalid');
  current?.controller.abort();
  current = null;
  const cand = { grader: r.grader, graderOptions: r.graderOptions, number: r.number, confidence: 1, source: 'manual', evidence: ['manual'] };
  last = { result: { status: 'confirm', candidates: [cand], warnings: [] }, job: null, input: null };
  ui.reset();
  ui.showResult({ candidates: [cand], warnings: [] });
  ui.setState('confirm');
  if (r.grader) {
    try {
      await openCert(cand, null, settings, { windowId });
      ui.setState('opened');
      ui.announce(t('stateOpened', [graderLabel(r.grader), r.number]));
    } catch {
      ui.fieldError(t('errorOpenFailed'));
    }
  } else {
    ui.announce(t('stateConfirmGrader'));
    ui.el.graderSelect.focus();
  }
});

// ---------------------------------------------------------------- history + settings

function renderHistory(h) {
  ui.renderHistory(h.entries, async (entry) => {
    const cand = { grader: entry.grader, graderOptions: [entry.grader], number: entry.number, confidence: 1, source: entry.source, evidence: ['history'] };
    try {
      current?.controller.abort();
      current = null;
      await openCert({ grader: entry.grader, number: entry.number, source: entry.source }, null, settings, { windowId });
      last = { result: { status: 'confirm', candidates: [cand], warnings: [] }, job: null, input: null };
      ui.reset();
      ui.showResult({ candidates: [cand], warnings: [] });
      ui.setState('opened');
      ui.announce(t('stateOpened', [graderLabel(entry.grader), entry.number]));
    } catch {
      ui.announce(t('errorOpenFailed'));
    }
  });
}

ui.el.historyClear.addEventListener('click', async () => {
  await clearHistory().catch(() => {});
  renderHistory({ entries: [] });
  ui.announce(t('stateHistoryCleared'));
});

const historyOff = document.getElementById('history-off-confirm');
for (const key of ['autoOpen', 'openInBackground', 'saveHistory']) {
  const box = document.querySelector(`[data-testid="setting-${key}"]`);
  box.addEventListener('change', async () => {
    if (key === 'saveHistory' && !box.checked) {
      // Turning history off deletes it: ask first, keep the box on until confirmed.
      box.checked = true;
      historyOff.hidden = false;
      document.getElementById('history-off-no').focus();
      return;
    }
    await applySetting({ [key]: box.checked });
  });
}
document.getElementById('history-off-yes').addEventListener('click', async () => {
  historyOff.hidden = true;
  if (await applySetting({ saveHistory: false })) {
    await clearHistory().catch(() => {});
    renderHistory({ entries: [] });
  }
  document.querySelector('[data-testid="setting-saveHistory"]').focus();
});
document.getElementById('history-off-no').addEventListener('click', () => {
  historyOff.hidden = true;
  document.querySelector('[data-testid="setting-saveHistory"]').focus();
});

async function applySetting(patch) {
  try {
    settings = await saveSettings(patch);
    ui.renderSettings(settings);
    ui.settingsStatus(t('settingsSaved'));
    return true;
  } catch {
    ui.renderSettings(settings);
    ui.settingsStatus(t('errorSettingsSave'));
    return false;
  }
}

// ---------------------------------------------------------------- bootstrap

wireInputs({
  dropZone: document.getElementById('drop-zone'),
  uploadInput: document.querySelector('[data-testid="upload-input"]'),
  onBlob: (blob, method) => startScan({ kind: 'blob', blob, method }, { fromPanel: true }),
});

window.addEventListener('pagehide', () => {
  current?.controller.abort();
  disposeEngines();
});

(async () => {
  try { settings = await loadSettings(); } catch { settings = { ...DEFAULT_SETTINGS }; }
  ui.renderSettings(settings);
  onSettingsChanged((s) => { settings = s; ui.renderSettings(s); });
  try { renderHistory(await loadHistory()); } catch { renderHistory({ entries: [] }); }
  onHistoryChanged(renderHistory);
  refreshSites();
  onPermissionsChanged(() => refreshSites());

  windowId = await resolveTargetWindowId(location.search);
  document.body.dataset.windowId = String(windowId);
  startJobIntake({ windowId, onJob: (job) => startScan({ kind: 'job', job }) });
  document.body.dataset.ready = '1';
})();
