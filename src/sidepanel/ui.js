// Side-panel rendering (UX spec §2.3, §3; ADR §13 + A4). Templates are cloned from sidepanel.html and filled
// with textContent/attributes only: OCR, QR, page and file text never reach innerHTML.
// Elements with ADR §13 test ids are singletons: parked in #parking and moved into [data-slot] placeholders,
// so every id exists exactly once at all times.
import { t, applyI18n } from '../shared/i18n.js';
import { createCertField } from './certField.js';
import { GRADER_LABEL, methodKey, displayUrl, relativeTime, stepStates } from './viewModel.js';
import { buildCertUrl } from '../core/certUrls.js';

export const BODY_STATES = Object.freeze(['idle', 'scanning', 'auto-open', 'confirm', 'none', 'error', 'opened']);
export const TASK_STATES = Object.freeze(['idle', 'scanning', 'result', 'edit', 'confirm', 'none', 'error']);
const TONE_ICON = { success: 'i-circle-check', info: 'i-circle-i', warning: 'i-triangle', danger: 'i-circle-x' };
const RECENT_VISIBLE = 5;
const COPIED_MS = 2000;
const SLOW_MS = 8000;

export const graderName = (g) => (g && GRADER_LABEL[g] ? t(GRADER_LABEL[g]) : t('candidate_grader_unknown'));
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const isTextField = (el) => Boolean(el && (el.matches?.('input[type="text"], input:not([type]), textarea, select') || el.isContentEditable));

export function createUi(doc, actions) {
  const $ = (id) => doc.getElementById(id);
  const task = $('task');
  const heading = $('task-heading');
  const headingText = $('task-heading-text');
  const headingIcon = heading.querySelector('.state-icon');
  const body = $('task-body');
  const status = $('status');
  const parking = $('parking');
  const singles = Object.fromEntries([...parking.querySelectorAll('[data-single]')].map((el) => [el.dataset.single, el]));
  const ref = (root, name) => root.querySelector(`[data-ref="${name}"]`);
  let field = null;
  let slowTimer = null;
  let stages = [];
  let lastAnnounced = '';
  let thumbUrl = null;
  let recentExpanded = false;
  let currentCandidates = [];

  applyI18n(parking);
  singles.certform.addEventListener('submit', (e) => { e.preventDefault(); actions.submitTaskForm(); });
  singles.candidates.addEventListener('change', (e) => {
    const c = currentCandidates[Number(e.target.value)];
    if (!c) return;
    fillRead(c, { path: null });
    field?.fill(c.number, c.grader);
    actions.candidatePicked?.(c);
  });

  // ------------------------------------------------------------ helpers
  /** Move every singleton back to #parking and clear its content, so hidden ids never expose stale results. */
  function park() {
    for (const el of Object.values(singles)) if (el.parentElement !== parking) parking.appendChild(el);
    singles.thumb.classList.remove('is-large');
    for (const name of ['chip', 'number', 'method', 'path']) ref(singles.read, name).textContent = '';
    const items = ref(singles.candidates, 'candidate-items');
    while (items.firstChild) items.firstChild.remove();
    currentCandidates = [];
    const form = singles.certform;
    ref(form, 'input').value = '';
    for (const r of form.querySelectorAll('input[type="radio"]')) r.checked = false;
    ref(form, 'graders').dataset.value = '';
    for (const name of ['error', 'grader-hint', 'preview-line', 'form-copy-error']) ref(form, name).textContent = '';
    singles.error.textContent = '';
    delete singles.error.dataset.code;
    delete singles.error.dataset.errorId;
  }

  function clone(id) {
    const frag = $(id).content.cloneNode(true);
    applyI18n(frag);
    for (const slot of frag.querySelectorAll('[data-slot]')) slot.replaceWith(singles[slot.dataset.slot]);
    return frag;
  }

  /** F3: polite status; an identical message is cleared and re-set after 100 ms so it is read again. */
  function announce(text) {
    if (!text) return;
    if (status.textContent === text || lastAnnounced === text) {
      status.textContent = '';
      setTimeout(() => { status.textContent = text; }, 100);
    } else {
      status.textContent = text;
    }
    lastAnnounced = text;
  }

  /** F1/F2/F5 after a task-card state change. */
  function settle(summary, { moveFocus = true } = {}) {
    const hadFocus = doc.hasFocus();
    const typing = isTextField(doc.activeElement) && !task.contains(doc.activeElement);
    if (moveFocus && !typing) heading.focus({ preventScroll: false });
    if (!hadFocus || typing || !moveFocus) announce(summary);
  }

  function setHeading(text, tone = null) {
    headingText.textContent = text;
    if (tone) {
      headingIcon.querySelector('use').setAttribute('href', `#${TONE_ICON[tone]}`);
      headingIcon.removeAttribute('hidden'); // SVG elements have no .hidden property
      task.dataset.tone = tone;
    } else {
      headingIcon.setAttribute('hidden', '');
      delete task.dataset.tone;
    }
  }

  function setTaskState(state) {
    if (!TASK_STATES.includes(state)) throw new RangeError(state);
    clearTimeout(slowTimer);
    field?.destroy();
    field = null;
    park();
    task.dataset.state = state;
    if (state === 'scanning') task.setAttribute('aria-busy', 'true'); else task.removeAttribute('aria-busy');
    while (body.firstChild) body.firstChild.remove();
  }

  function setBodyState(state) {
    if (!BODY_STATES.includes(state)) throw new RangeError(state);
    doc.body.dataset.state = state;
  }

  /** Thumbnail singleton: image when known; placeholder only while scanning; hidden otherwise. */
  function setThumb({ thumbUrl: url = null, thumbAlt = '' }, { placeholder = false } = {}) {
    const box = singles.thumb;
    const img = box.querySelector('img');
    const ph = box.querySelector('.thumb-placeholder');
    if (url) {
      img.src = url;
      img.alt = thumbAlt;
      img.hidden = false;
      ph.setAttribute('hidden', '');
      box.hidden = false;
    } else {
      img.removeAttribute('src');
      img.alt = '';
      img.hidden = true;
      if (placeholder) ph.removeAttribute('hidden'); else ph.setAttribute('hidden', '');
      box.hidden = !placeholder;
    }
  }

  /** Object URL for the current thumbnail; revoked when replaced or cleared. */
  function thumbnail(blob) {
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    thumbUrl = blob ? URL.createObjectURL(blob) : null;
    return thumbUrl;
  }

  function fillRead(c, { path }) {
    const r = singles.read;
    ref(r, 'chip').textContent = c.grader ? graderName(c.grader) : t('candidate_grader_unknown');
    ref(r, 'number').textContent = c.number;
    ref(r, 'method').textContent = t(methodKey(c.method ?? c.source));
    const p = ref(r, 'path');
    p.textContent = path ?? '';
    p.hidden = !path;
  }

  function offline(root) {
    const el = ref(root, 'offline');
    if (el) el.hidden = navigator.onLine !== false;
  }

  function mountForm({ number, grader, withCopy = false, withCancel = false, cgcHint = true }) {
    const form = singles.certform;
    const input = ref(form, 'input');
    const error = ref(form, 'error');
    error.textContent = '';
    error.classList.remove('is-warning');
    input.removeAttribute('aria-invalid');
    ref(form, 'form-copy-error').textContent = '';
    if (withCopy) ref(form, 'form-copy-slot').appendChild(singles.copy);
    ref(form, 'form-cancel').hidden = !withCancel;
    resetCopyLabel();
    field = createCertField({
      input, fieldset: ref(form, 'graders'), errorEl: error, previewEl: ref(form, 'preview-line'), hintEl: ref(form, 'grader-hint'),
      radioName: 'task-grader', prefill: { number, grader }, cgcHint,
    });
    return { form, input };
  }

  function resetCopyLabel() {
    ref(singles.copy, 'copy-label').textContent = t('copy_button');
  }

  function qrBlock(root, qrHost, numberUsed) {
    const slot = ref(root, 'qr-slot');
    if (!slot || !qrHost) return;
    const frag = clone('tpl-qr-warning');
    ref(frag, 'qr-body').textContent = t('qr_offsite_body', [qrHost]);
    ref(frag, 'qr-number').hidden = !numberUsed;
    slot.appendChild(frag);
  }

  /** N1 notice in one of its sub-states: offer | granted | denied | failed. */
  function renderLowres(slot, lowres) {
    if (singles.sharper.parentElement !== parking) parking.appendChild(singles.sharper);
    while (slot.firstChild) slot.firstChild.remove();
    if (!lowres) return;
    const frag = clone('tpl-lowres');
    const box = ref(frag, 'lowres-box');
    const title = ref(frag, 'lowres-title');
    const bodyEl = ref(frag, 'lowres-body');
    const actionsRow = ref(frag, 'lowres-actions');
    const fine = ref(frag, 'lowres-fine');
    const notNow = frag.querySelector('[data-action="not-now"]');
    const rescanRow = ref(frag, 'rescan-row');
    const host = lowres.host;
    ref(singles.sharper, 'sharper-label').textContent = t('lowres_button', [host]);
    singles.sharper.title = host;
    const setIcon = (name) => ref(frag, 'lowres-icon')?.setAttribute('href', `#${name}`);
    if (lowres.state === 'offer') {
      title.textContent = t('lowres_title');
      bodyEl.textContent = t('lowres_body', [host]);
      fine.textContent = t('lowres_fineprint', [host]);
    } else if (lowres.state === 'granted') {
      box.className = 'alert alert-success';
      setIcon('i-circle-check');
      title.textContent = t('perm_granted', [host]);
      bodyEl.hidden = true; actionsRow.hidden = true; fine.hidden = true; notNow.hidden = true;
      rescanRow.hidden = false;
      if (lowres.primary) rescanRow.querySelector('button').className = 'btn btn-primary';
    } else if (lowres.state === 'denied') {
      box.className = 'alert alert-neutral';
      setIcon('i-circle-i');
      title.hidden = true;
      bodyEl.textContent = t('perm_denied', [host]);
      actionsRow.hidden = true; fine.hidden = true; notNow.hidden = true;
    } else if (lowres.state === 'failed') {
      box.className = 'alert alert-danger';
      setIcon('i-circle-x');
      title.textContent = t('perm_failed');
      bodyEl.hidden = true; fine.hidden = true;
    }
    slot.appendChild(frag);
  }

  // ------------------------------------------------------------ states
  function showIdle({ focus = false } = {}) {
    setTaskState('idle');
    setHeading(t('idle_heading'));
    const frag = clone('tpl-idle');
    ref(frag, 'idle-body').textContent = t('idle_body', [t('context_menu_scan')]);
    body.appendChild(frag);
    if (focus) heading.focus({ preventScroll: false });
  }

  function showScanning({ caption = '', thumbUrl: url = null, thumbAlt = '' } = {}) {
    setTaskState('scanning');
    setHeading(t('scan_heading'));
    stages = [];
    const frag = clone('tpl-scanning');
    ref(frag, 'caption').textContent = caption;
    body.appendChild(frag);
    setThumb({ thumbUrl: url, thumbAlt }, { placeholder: true });
    renderSteps();
    slowTimer = setTimeout(() => { const s = ref(body, 'slow'); if (s) s.hidden = false; }, SLOW_MS);
    settle(t('status_scan_started'));
  }

  function progress(stage) {
    if (task.dataset.state !== 'scanning') return;
    if (!stages.includes(stage)) stages.push(stage);
    renderSteps();
  }

  function renderSteps() {
    const s = stepStates(stages);
    const icons = { waiting: 'i-circle', active: reducedMotion() ? 'i-half' : 'i-spinner', done: 'i-step-done', skipped: 'i-circle-dash' };
    const labels = { waiting: 'step_state_waiting', active: 'step_state_active', done: 'step_state_done', skipped: 'step_state_skipped' };
    for (const li of singles.steps.children) {
      const state = s[li.dataset.step];
      li.dataset.state = state;
      li.querySelector('use').setAttribute('href', `#${icons[state]}`);
      li.querySelector('.step-state').textContent = t(labels[state]);
      const sub = li.querySelector('.step-sub');
      if (sub) sub.hidden = !s.textStarting;
    }
  }

  function updateScanThumb(url, alt) {
    if (task.dataset.state === 'scanning') setThumb({ thumbUrl: url, thumbAlt: alt }, { placeholder: true });
  }

  /** S2. view: {opened:{grader, number, method, url, background, tabId}, thumbUrl, thumbAlt} */
  function showResult(view, { moveFocus = true } = {}) {
    setTaskState('result');
    const o = view.opened;
    setHeading(t('result_heading', [graderName(o.grader)]), 'success');
    const frag = clone('tpl-result');
    ref(frag, 'bg-note').hidden = !(o.background && Number.isInteger(o.tabId));
    body.appendChild(frag);
    fillRead({ grader: o.grader, number: o.number, method: o.method }, { path: displayUrl(o.url ?? buildCertUrl(o.grader, o.number)) });
    // The (parked) grader control mirrors the opened grader so §13 readers see the routed grader in S2 too.
    for (const r of singles.certform.querySelectorAll('input[type="radio"]')) r.checked = r.value === o.grader;
    ref(singles.certform, 'graders').dataset.value = o.grader;
    setThumb(view);
    resetCopyLabel();
    offline(body);
    settle(t('status_opened', [graderName(o.grader), o.number]), { moveFocus });
  }

  function showOpenError() {
    const el = ref(body, 'open-error');
    if (el) el.hidden = false;
  }

  function showCopyState(ok) {
    const label = ref(singles.copy, 'copy-label');
    const err = ref(body, 'copy-error') ?? ref(singles.certform, 'form-copy-error');
    if (ok) {
      label.textContent = t('copy_done');
      setTimeout(() => { label.textContent = t('copy_button'); }, COPIED_MS);
    }
    if (err) err.textContent = ok ? '' : t('copy_failed');
  }

  /** S2e. */
  function showEdit({ number, grader }) {
    setTaskState('edit');
    setHeading(t('edit_heading'));
    body.appendChild(clone('tpl-edit'));
    const { input } = mountForm({ number, grader, withCancel: true });
    offline(body);
    input.focus();
    input.select();
  }

  /**
   * S3. view: {result, reasons:[{key,subs}], candidates, thumbUrl, thumbAlt, caption, qrHost, qrNumberUsed, lowres, prefill}
   */
  function showConfirm(view, { moveFocus = true } = {}) {
    setTaskState('confirm');
    setHeading(t('confirm_heading'), 'info');
    body.appendChild(clone('tpl-confirm'));
    qrBlock(body, view.qrHost, view.qrNumberUsed);
    if (view.reasons.length) {
      const list = ref(body, 'reason-list');
      for (const r of view.reasons) {
        const p = doc.createElement('p');
        p.textContent = t(r.key, r.subs);
        list.appendChild(p);
      }
      ref(body, 'reasons').hidden = false;
    }
    setThumb(view);
    ref(body, 'caption').textContent = view.caption ?? '';
    const larger = ref(body, 'larger');
    larger.hidden = !view.thumbUrl;
    larger.textContent = t('image_larger');
    const cands = view.candidates.slice(0, 3);
    currentCandidates = cands;
    fillRead(cands[0], { path: null });
    const fs = singles.candidates;
    const items = ref(fs, 'candidate-items');
    while (items.firstChild) items.firstChild.remove();
    fs.hidden = cands.length < 2;
    if (cands.length >= 2) {
      cands.forEach((c, i) => {
        const cf = clone('tpl-candidate');
        const label = cf.querySelector('label');
        const radio = cf.querySelector('input');
        label.dataset.testid = `candidate-${i}`;
        radio.value = String(i);
        radio.checked = i === 0;
        ref(cf, 'number').textContent = c.number;
        ref(cf, 'best').hidden = i !== 0;
        const meta = [t(methodKey(c.source)), c.grader ? t('candidate_grader_guess', [graderName(c.grader)]) : t('candidate_grader_unknown')];
        ref(cf, 'meta').textContent = meta.join(' · ');
        items.appendChild(cf);
      });
    }
    mountForm({ ...view.prefill, withCopy: true, cgcHint: !view.reasons.some((r) => r.key === 'reason_cgc_both') });
    renderLowres(ref(body, 'lowres-slot'), view.lowres);
    offline(body);
    const summary = [t('confirm_heading'), view.reasons[0] ? t(view.reasons[0].key, view.reasons[0].subs) : ''].filter(Boolean).join('. ');
    settle(summary, { moveFocus });
  }

  function toggleLarger() {
    const box = singles.thumb;
    const btn = ref(body, 'larger');
    if (!btn) return;
    const large = !box.classList.contains('is-large');
    box.classList.toggle('is-large', large);
    btn.setAttribute('aria-expanded', String(large));
    btn.textContent = t(large ? 'image_smaller' : 'image_larger');
  }

  /** S4. view: {thumbUrl, thumbAlt, qrHost, lowres, ocrUnavailable} */
  function showNone(view, { moveFocus = true } = {}) {
    setTaskState('none');
    setHeading(t('none_heading'), 'info');
    body.appendChild(clone('tpl-none'));
    setThumb(view);
    qrBlock(body, view.qrHost, false);
    ref(body, 'ocr-note').hidden = !view.ocrUnavailable;
    renderLowres(ref(body, 'lowres-slot'), view.lowres);
    settle(t('none_heading'), { moveFocus });
  }

  /** S5. ev = errorView(...) */
  function showError(ev, { code, moveFocus = true } = {}) {
    setTaskState('error');
    setHeading(t(ev.heading), ev.tone);
    const frag = clone('tpl-error');
    for (const b of frag.querySelectorAll('[data-action]')) b.hidden = !ev.actions.includes(b.dataset.action);
    body.appendChild(frag);
    const p = singles.error;
    p.textContent = t(ev.body, ev.bodySubs);
    p.dataset.code = code ?? '';
    p.dataset.errorId = ev.id;
    settle(`${t(ev.heading)}. ${t(ev.body, ev.bodySubs)}`, { moveFocus });
  }

  function lowresFocus(target) {
    if (target === 'rescan') body.querySelector('[data-action="rescan"]')?.focus();
    else if (target === 'box') ref(body, 'lowres-box')?.focus();
    else heading.focus();
  }

  // ------------------------------------------------------------ recent + settings
  function renderRecent(entries, { historyOn, onOpen, onCopy, now = Date.now(), locale = 'en' }) {
    const list = $('recent-list');
    const empty = $('recent-empty');
    const toggle = $('recent-toggle');
    while (list.firstChild) list.firstChild.remove();
    if (!historyOn) {
      empty.textContent = t('recent_off');
      empty.hidden = false;
      toggle.hidden = true;
      return;
    }
    empty.textContent = t('recent_empty');
    empty.hidden = entries.length > 0;
    const shown = recentExpanded ? entries : entries.slice(0, RECENT_VISIBLE);
    shown.forEach((e, i) => {
      const frag = clone('tpl-recent-row');
      const base = `recent-${i}`;
      const chip = ref(frag, 'chip');
      const number = ref(frag, 'number');
      const openLabel = ref(frag, 'open-label');
      const copyLabel = ref(frag, 'copy-label');
      const open = ref(frag, 'open');
      const copy = ref(frag, 'copy');
      chip.id = `${base}-chip`;
      number.id = `${base}-number`;
      openLabel.id = `${base}-open`;
      copyLabel.id = `${base}-copy`;
      chip.textContent = graderName(e.grader);
      number.textContent = e.number;
      const time = ref(frag, 'time');
      time.textContent = relativeTime(e.at, now, locale);
      time.title = new Date(e.at).toLocaleString(locale);
      open.setAttribute('aria-labelledby', `${openLabel.id} ${chip.id} ${number.id}`);
      copy.setAttribute('aria-labelledby', `${copyLabel.id} ${number.id}`);
      copy.title = `${t('recent_copy')} ${e.number}`;
      open.addEventListener('click', () => onOpen(e));
      copy.addEventListener('click', () => onCopy(e));
      list.appendChild(frag);
    });
    toggle.hidden = entries.length <= RECENT_VISIBLE;
    toggle.setAttribute('aria-expanded', String(recentExpanded));
    toggle.textContent = recentExpanded ? t('recent_show_fewer') : t('recent_show_all', [String(entries.length)]);
  }

  function toggleRecent() { recentExpanded = !recentExpanded; }

  function renderSettings(s, { historyCount }) {
    $('setting-always-ask').checked = !s.autoOpen;
    $('setting-background').checked = Boolean(s.openInBackground);
    $('setting-history').checked = Boolean(s.saveHistory);
    const clear = $('clear-history');
    const empty = historyCount === 0;
    if (empty) clear.setAttribute('aria-disabled', 'true'); else clear.removeAttribute('aria-disabled');
    $('history-empty-hint').hidden = !empty;
  }

  /** Sharper-scans sites; an "All sites" row first when a wildcard grant exists (SEC-11). */
  function renderSites({ hosts, allSites }, { onRemove, onRemoveAll }) {
    const list = $('sites-list');
    while (list.firstChild) list.firstChild.remove();
    const rows = [...(allSites.length ? [{ all: true, label: t('settings_sites_all') }] : []), ...hosts.map((h) => ({ all: false, label: h }))];
    rows.forEach((row, i) => {
      const frag = clone('tpl-site-row');
      const h = ref(frag, 'host');
      const btn = ref(frag, 'remove');
      const label = ref(frag, 'remove-label');
      h.id = `site-${i}-host`;
      label.id = `site-${i}-remove`;
      h.textContent = row.label;
      if (row.all) h.title = allSites.join(', ');
      btn.setAttribute('aria-labelledby', `${label.id} ${h.id}`);
      btn.dataset.host = row.all ? '*' : row.label;
      const hostIndex = allSites.length ? i - 1 : i;
      btn.addEventListener('click', () => (row.all ? onRemoveAll() : onRemove(row.label, hostIndex)));
      list.appendChild(frag);
    });
    $('sites-empty').hidden = rows.length > 0;
  }

  return {
    announce, settle, setBodyState, thumbnail, progress, updateScanThumb, toggleLarger, toggleRecent, lowresFocus, renderLowres,
    showIdle, showScanning, showResult, showOpenError, showCopyState, showEdit, showConfirm, showNone, showError,
    renderRecent, renderSettings, renderSites,
    get field() { return field; },
    get taskState() { return task.dataset.state; },
    heading,
  };
}
