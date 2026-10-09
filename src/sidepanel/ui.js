// Side-panel rendering (ADR-001 §13): body[data-state], aria-live status, focus management.
// textContent / attributes only. OCR, QR and page text never reach innerHTML.
import { t } from '../shared/i18n.js';

// ADR §13 + amendment A4: 'opened' = cert page opened by the user (confirm, edit, manual entry, recent).
export const STATES = Object.freeze(['idle', 'scanning', 'auto-open', 'confirm', 'none', 'error', 'opened']);
export const GRADER_LABEL_KEYS = Object.freeze({ psa: 'graderPsa', 'cgc-comics': 'graderCgcComics', 'cgc-cards': 'graderCgcCards' });
const SOURCE_KEYS = Object.freeze({ ocr: 'sourceOcr', barcode: 'sourceBarcode', 'qr-url': 'sourceQrUrl', manual: 'sourceManual' });
const STAGE_KEYS = Object.freeze({ acquire: 'stateAcquire', decode: 'stateDecode', barcode: 'stateBarcode', 'ocr-init': 'stateOcrInit', ocr: 'stateOcr', parse: 'stateParse' });
const STAGE_BASE = Object.freeze({ acquire: 0.05, decode: 0.15, barcode: 0.2, 'ocr-init': 0.3, ocr: 0.35, parse: 0.95 });
const ERROR_KEYS = Object.freeze({
  restricted: 'errorRestricted', 'not-found': 'errorNotFound', 'too-large': 'errorTooLarge', 'fetch-failed': 'errorFetchFailed',
  'capture-failed': 'errorCaptureFailed', 'tab-changed': 'errorTabChanged', 'invalid-image': 'errorInvalidImage',
  'engine-failed': 'errorEngineFailed', timeout: 'errorTimeout', aborted: 'errorAborted',
});
const WARNING_KEYS = Object.freeze({ 'qr-untrusted-host': 'warningQrUntrusted', 'low-resolution': 'warningLowResolution', 'ocr-unavailable': 'warningOcrUnavailable' });

export const graderLabel = (g) => (g && GRADER_LABEL_KEYS[g] ? t(GRADER_LABEL_KEYS[g]) : t('stateNoGrader'));
export const errorText = (code) => t(ERROR_KEYS[code] ?? 'errorEngineFailed');

const pct = (c) => String(Math.round((Number(c) || 0) * 100));

/** Remove all children without parsing HTML. */
function clear(node) { while (node.firstChild) node.firstChild.remove(); }

export function createUi(doc = document) {
  const $ = (id) => doc.getElementById(id);
  const el = {
    body: doc.body,
    status: $('status-live'),
    progress: $('progress'),
    cancel: $('cancel-button'),
    errorBox: $('error-box'),
    errorMessage: $('error-message'),
    sharper: $('sharper-button'),
    result: $('result'),
    resultHeading: $('result-heading'),
    preview: $('preview'),
    resultGrader: $('result-grader'),
    resultNumber: $('result-number'),
    resultMeta: $('result-meta'),
    warnings: $('warnings'),
    candidatesBlock: $('candidates-block'),
    candidateList: $('candidate-list'),
    graderSelect: $('grader-select'),
    numberInput: $('number-input'),
    confirmError: $('confirm-error'),
    openButton: $('open-button'),
    copyButton: $('copy-button'),
    historyList: $('history-list'),
    historyEmpty: $('history-empty'),
    historyClear: $('history-clear'),
    settingsStatus: $('settings-status'),
    sitesList: $('sites-list'),
    sitesEmpty: $('sites-empty'),
  };
  let previewUrl = null;
  let candidates = [];

  function setState(state) {
    if (!STATES.includes(state)) throw new RangeError(state);
    el.body.dataset.state = state;
    const scanning = state === 'scanning';
    el.progress.hidden = !scanning;
    el.cancel.hidden = !scanning;
    el.body.setAttribute('aria-busy', String(scanning));
    if (state !== 'error') el.errorBox.hidden = true;
    const withResult = state === 'auto-open' || state === 'confirm' || state === 'opened';
    el.result.hidden = !(withResult || state === 'none' || (state === 'error' && previewUrl));
    el.candidatesBlock.hidden = !withResult;
  }

  function announce(text) {
    // Re-set the text so repeated identical messages are announced again.
    el.status.textContent = '';
    el.status.textContent = text;
  }

  /** Clear the previous result without changing state. */
  function reset() {
    candidates = [];
    clear(el.candidateList);
    clear(el.warnings);
    el.resultGrader.textContent = '';
    el.resultNumber.textContent = '';
    el.resultMeta.textContent = '';
    el.confirmError.textContent = '';
    el.numberInput.value = '';
    el.numberInput.removeAttribute('aria-invalid');
    el.graderSelect.value = '';
    el.sharper.hidden = true;
    el.errorMessage.textContent = '';
    el.errorBox.hidden = true;
    el.progress.value = 0;
    setPreview(null);
  }

  function beginScan() {
    reset();
    setState('scanning');
    announce(t('stateScanning'));
  }

  function showProgress({ stage, fraction }) {
    const base = STAGE_BASE[stage] ?? 0;
    const value = stage === 'ocr' && typeof fraction === 'number' ? 0.35 + 0.6 * fraction : base;
    el.progress.value = Math.max(Number(el.progress.value) || 0, value);
    const msg = t(STAGE_KEYS[stage] ?? 'stateScanning');
    if (el.status.textContent !== msg) announce(msg);
  }

  function setPreview(blob) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = blob ? URL.createObjectURL(blob) : null;
    if (previewUrl) { el.preview.src = previewUrl; el.preview.hidden = false; } else { el.preview.removeAttribute('src'); el.preview.hidden = true; }
  }

  function renderWarnings(warnings) {
    clear(el.warnings);
    for (const w of warnings ?? []) {
      const key = WARNING_KEYS[w.code];
      if (!key) continue;
      const li = doc.createElement('li');
      li.textContent = t(key, w.detail ? [String(w.detail).slice(0, 253)] : undefined);
      li.dataset.code = w.code;
      el.warnings.appendChild(li);
    }
    if (el.warnings.parentElement) el.warnings.parentElement.hidden = !el.warnings.children.length;
  }

  function selectCandidate(i) {
    const c = candidates[i];
    if (!c) return;
    el.graderSelect.value = c.grader ?? '';
    // Offer only graders valid for this number first; all graders stay selectable.
    el.numberInput.value = c.number;
    el.numberInput.removeAttribute('aria-invalid');
    el.confirmError.textContent = '';
    el.resultGrader.textContent = graderLabel(c.grader);
    el.resultNumber.textContent = c.number;
    const sourceText = t(SOURCE_KEYS[c.source] ?? 'sourceOcr');
    const noScore = c.source === 'manual' || c.evidence?.includes('history');
    el.resultMeta.textContent = noScore ? sourceText : `${sourceText} · ${t('stateConfidence', [pct(c.confidence)])}`;
    for (const [j, li] of [...el.candidateList.children].entries()) {
      li.querySelector('button')?.setAttribute('aria-pressed', String(i === j));
    }
  }

  /**
   * @param {import('../core/types.js').ScanResult} result
   */
  function showResult(result) {
    candidates = result.candidates ?? [];
    clear(el.candidateList);
    candidates.forEach((c, i) => {
      const li = doc.createElement('li');
      const b = doc.createElement('button');
      b.type = 'button';
      b.dataset.testid = `candidate-${i}`;
      b.dataset.index = String(i);
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', t('a11yCandidate', [c.number, graderLabel(c.grader), pct(c.confidence)]));
      const n = doc.createElement('span');
      n.className = 'cand-number';
      n.textContent = c.number;
      const g = doc.createElement('span');
      g.className = 'cand-grader';
      g.textContent = graderLabel(c.grader);
      const p = doc.createElement('span');
      p.className = 'cand-conf';
      p.textContent = c.source === 'manual' || c.evidence?.includes('history')
        ? t(SOURCE_KEYS[c.source] ?? 'sourceManual') : t('stateConfidence', [pct(c.confidence)]);
      b.append(n, g, p);
      li.appendChild(b);
      el.candidateList.appendChild(li);
    });
    renderWarnings(result.warnings);
    if (candidates.length) selectCandidate(0);
  }

  function showError(code, { canRequestSharper = false, origin = null } = {}) {
    el.errorMessage.textContent = errorText(code);
    el.errorBox.hidden = false;
    let host = null;
    try { host = origin ? new URL(origin).hostname : null; } catch { host = null; }
    el.sharper.hidden = !(canRequestSharper && host);
    if (host) {
      el.sharper.textContent = t('actionSharper', [host]);
      el.sharper.dataset.origin = origin;
    }
  }

  function showSharper(origin) {
    let host = null;
    try { host = origin ? new URL(origin).hostname : null; } catch { host = null; }
    if (!host) { el.sharper.hidden = true; return; }
    el.sharper.textContent = t('actionSharper', [host]);
    el.sharper.dataset.origin = origin;
    el.sharper.hidden = false;
    el.errorBox.hidden = false;
  }

  /** Current confirm-form values. */
  function selection() {
    return { grader: el.graderSelect.value || null, number: el.numberInput.value.replace(/[\s-]/g, '') };
  }

  function fieldError(message) {
    el.confirmError.textContent = message;
    if (message) el.numberInput.setAttribute('aria-invalid', 'true'); else el.numberInput.removeAttribute('aria-invalid');
  }

  function focusResult() {
    const active = doc.activeElement;
    // Do not steal focus from someone typing elsewhere.
    if (active && active !== doc.body && active.matches?.('input[type=text], input:not([type]), select, textarea')) return;
    el.resultHeading.focus({ preventScroll: false });
  }

  function renderHistory(entries, onOpen) {
    clear(el.historyList);
    for (const e of entries) {
      const li = doc.createElement('li');
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'history-item';
      b.setAttribute('aria-label', t('a11yHistoryOpen', [graderLabel(e.grader), e.number]));
      const g = doc.createElement('span');
      g.textContent = graderLabel(e.grader);
      const n = doc.createElement('span');
      n.className = 'cand-number';
      n.textContent = e.number;
      const h = doc.createElement('span');
      h.className = 'history-host';
      h.textContent = e.pageHost ?? '';
      const time = doc.createElement('time');
      const d = new Date(e.at);
      time.dateTime = d.toISOString();
      time.textContent = d.toLocaleString(doc.documentElement.lang || undefined, { dateStyle: 'short', timeStyle: 'short' });
      b.append(g, n, h, time);
      b.addEventListener('click', () => onOpen(e));
      li.appendChild(b);
      el.historyList.appendChild(li);
    }
    el.historyEmpty.hidden = entries.length > 0;
    el.historyClear.disabled = entries.length === 0;
  }

  function renderSettings(s) {
    for (const k of ['autoOpen', 'openInBackground', 'saveHistory']) {
      const box = doc.querySelector(`[data-testid="setting-${k}"]`);
      if (box) box.checked = Boolean(s[k]);
    }
  }

  function settingsStatus(text) {
    el.settingsStatus.textContent = '';
    el.settingsStatus.textContent = text;
  }

  function renderSites(hosts, onRemove) {
    clear(el.sitesList);
    for (const host of hosts) {
      const li = doc.createElement('li');
      const span = doc.createElement('span');
      span.textContent = host;
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = t('actionRemoveSite');
      b.setAttribute('aria-label', t('a11yRemoveSite', [host]));
      b.addEventListener('click', () => onRemove(host));
      li.append(span, b);
      el.sitesList.appendChild(li);
    }
    el.sitesEmpty.hidden = hosts.length > 0;
  }

  return {
    el, setState, announce, reset, beginScan, showProgress, setPreview, showResult, selectCandidate, showError, showSharper,
    selection, fieldError, focusResult, renderHistory, renderSettings, settingsStatus, renderSites,
    get candidates() { return candidates; },
  };
}
