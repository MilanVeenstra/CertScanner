// Side-panel rendering (UX spec §2.3, §3; ADR §13 + A4). Templates are cloned from sidepanel.html and filled
// with textContent/attributes only: OCR, QR, page and file text never reach innerHTML.
// Elements with ADR §13 test ids are singletons: parked in #parking and moved into [data-slot] placeholders,
// so every id exists exactly once at all times.
import { t, applyI18n } from '../shared/i18n.js';
import { createCertField } from './certField.js';
import { GRADER_LABEL, methodKey, displayUrl, relativeTime, stepStates, openedStatusKey } from './viewModel.js';
import { pageRowNote } from './pageView.js';
import { buildCertUrl, hasDirectUrl } from '../core/certUrls.js';
import { ebayHostLabel, GRADE_SCALES, gradeLabel, matchGrade, POP_URLS } from '../core/priceLinks.js';

// A9 adds body 'page-results' and task 'page-results' / 'page-access'.
export const BODY_STATES = Object.freeze(['idle', 'scanning', 'auto-open', 'confirm', 'none', 'error', 'opened', 'page-results']);
export const TASK_STATES = Object.freeze(['idle', 'scanning', 'result', 'edit', 'confirm', 'none', 'error', 'page-results', 'page-access']);
const TONE_ICON = { success: 'i-check', info: 'i-circle-i', warning: 'i-triangle', danger: 'i-circle-x' };
/** "Other ways to scan" per task state (design v2: open on Start, folded under a result, none, an error or no access;
 * not shown while scanning, on the page list or while the task card shows the number form). The user can still toggle
 * it; the next state change resets it. Recent scans are shown on Start only. */
const OTHER_WAYS = { idle: 'open', scanning: 'hidden', result: 'closed', 'page-results': 'hidden', none: 'closed', error: 'closed', 'page-access': 'closed', edit: 'hidden', confirm: 'hidden' };
/** Reasons on "Check the number" that only inform (grey icon); the others are what to check (red triangle). */
const INFO_REASONS = new Set(['reason_unclear', 'reason_always_ask', 'reason_bgs_lookup']);
const RECENT_VISIBLE = 5;
const SHOWN_EBAY_SALES = 4;
const COPIED_MS = 2000;
const SLOW_MS = 8000;

export const graderName = (g) => (g && GRADER_LABEL[g] ? t(GRADER_LABEL[g]) : t('candidate_grader_unknown'));
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** URL text with a line-break chance after each "/" only, so a narrow panel never splits the cert number (QA P3). */
function setPath(el, text) {
  el.textContent = '';
  String(text ?? '').split(/(?<=\/)/).forEach((part, i) => {
    if (i) el.appendChild(el.ownerDocument.createElement('wbr'));
    el.appendChild(el.ownerDocument.createTextNode(part));
  });
}
/** "PSA 10" never wraps between the grader and the grade. */
const keepTogether = (label) => String(label).replace(/ (?=[\d.]+\b)/g, '\u00a0');
const isTextField = (el) => Boolean(el && (el.matches?.('input[type="text"], input:not([type]), textarea, select') || el.isContentEditable));

export function createUi(doc, actions) {
  const $ = (id) => doc.getElementById(id);
  const task = $('task');
  const heading = $('task-heading');
  const headingText = $('task-heading-text');
  const headingIcon = heading.querySelector('.state-icon');
  const headingBadge = $('task-heading-badge');
  const body = $('task-body');
  /** Result sections under the task card: Value, eBay sales, Price per grade and "This went wrong" (design v2). */
  const extra = $('result-extra');
  /** A ref in the task card or, for the result, in its sections. */
  const refAny = (name) => ref(body, name) ?? ref(extra, name);
  const status = $('status');
  const parking = $('parking');
  const singles = Object.fromEntries([...parking.querySelectorAll('[data-single]')].map((el) => [el.dataset.single, el]));
  const ref = (root, name) => root.querySelector(`[data-ref="${name}"]`);
  // The read's method and URL lines move into "Cert check" in the result (layout A); park() puts them back.
  const readEls = Object.fromEntries(['chip', 'number', 'method', 'path'].map((n) => [n, ref(singles.read, n)]));
  let field = null;
  let slowTimer = null;
  let stages = [];
  let lastAnnounced = '';
  let thumbUrl = null;
  /** URL the preview shows normally (a small thumbnail) and, while "Show larger" is open, the full image's URL. */
  let shownThumbUrl = null;
  let largeUrl = null;
  let recentExpanded = false;
  let currentCandidates = [];
  /** Grader of the shown price block (its grade list). */
  let priceGrader = null;
  /** Result identity for the heading: {grader, number, title} (title: PSA's or PriceCharting's name, else the label's). */
  let identity = null;
  let valueAnnounced = false;

  applyI18n(parking);
  const otherWays = $('other-ways');
  const otherToggle = $('other-toggle');
  function setOtherWays(mode) {
    otherWays.hidden = mode === 'hidden';
    const open = mode === 'open';
    otherWays.dataset.open = String(open);
    otherToggle.setAttribute('aria-expanded', String(open));
  }
  otherToggle.addEventListener('click', () => setOtherWays(otherWays.dataset.open === 'true' ? 'closed' : 'open'));
  /** Unfold "Other ways to scan" (e.g. the task card's "Type a number" action); no-op while the task card shows the form. */
  function openOtherWays() { if (!otherWays.hidden) setOtherWays('open'); }
  singles.certform.addEventListener('submit', (e) => { e.preventDefault(); actions.submitTaskForm(); });
  // Check the number: a grader picked with the mouse or a tap is the choice, so it continues at once, as Open does
  // (user: "als je hebt gekozen dat hij ook doorgaat"). The arrow keys only move the choice; Enter opens.
  const graderGroup = ref(singles.certform, 'graders');
  let pointerPick = false;
  graderGroup.addEventListener('pointerdown', () => { pointerPick = true; });
  graderGroup.addEventListener('keydown', () => { pointerPick = false; });
  graderGroup.addEventListener('click', (e) => {
    if (!pointerPick || !e.target.matches?.('input[type="radio"]')) return;
    pointerPick = false;
    // After the click's change event, so the field submits the grader that was just picked.
    if (task.dataset.state === 'confirm') setTimeout(() => { if (task.dataset.state === 'confirm') actions.submitTaskForm(); });
  });
  // Possible numbers (confirm): one click on a row continues with it. With a known grader that is the normal process
  // (open + result with value); without one the number goes into the form and focus moves to the grader choice.
  singles.candidates.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-ref="use"]');
    const c = b ? currentCandidates[Number(b.dataset.index)] : null;
    if (!c) return;
    fillRead(c, { path: null });
    field?.fill(c.number, c.grader);
    syncOpenLabel();
    actions.candidatePicked?.(c);
    if (c.grader) actions.candidateChosen?.(c);
    else {
      singles.certform.hidden = false; // folded away while several numbers were offered (design v2)
      singles.certform.querySelector('input[name="task-grader"]')?.focus();
    }
  });

  // ------------------------------------------------------------ helpers
  /** Move every singleton back to #parking and clear its content, so hidden ids never expose stale results. */
  function park() {
    for (const el of Object.values(singles)) if (el.parentElement !== parking) parking.appendChild(el);
    closeLarger();
    singles.read.append(readEls.method, readEls.path);
    for (const el of Object.values(readEls)) el.textContent = '';
    readEls.path.hidden = false;
    const items = ref(singles.candidates, 'candidate-items');
    while (items.firstChild) items.firstChild.remove();
    currentCandidates = [];
    const form = singles.certform;
    form.hidden = false;
    ref(form, 'input').value = '';
    for (const r of form.querySelectorAll('input[type="radio"]')) r.checked = false;
    ref(form, 'graders').dataset.value = '';
    for (const name of ['error', 'grader-hint', 'preview-line', 'form-copy-error']) ref(form, name).textContent = '';
    singles.error.textContent = '';
    delete singles.error.dataset.code;
    delete singles.error.dataset.errorId;
    singles.pageprogress.textContent = '';
    singles.pageprogress.hidden = true;
    singles.steps.hidden = false;
    while (singles.pageresults.firstChild) singles.pageresults.firstChild.remove();
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
    headingBadge.hidden = true;
    headingBadge.textContent = '';
    identity = null;
    // QA P2-11: no announcement from the previous state stays readable in the live region.
    status.textContent = '';
    lastAnnounced = '';
    setOtherWays(OTHER_WAYS[state] ?? 'closed');
    $('recent').hidden = state !== 'idle';
    if (state === 'scanning') task.setAttribute('aria-busy', 'true'); else task.removeAttribute('aria-busy');
    while (body.firstChild) body.firstChild.remove();
    while (extra.firstChild) extra.firstChild.remove();
  }

  function setBodyState(state) {
    if (!BODY_STATES.includes(state)) throw new RangeError(state);
    doc.body.dataset.state = state;
  }

  /** Thumbnail singleton: image when known; placeholder only while scanning; hidden otherwise. */
  function setThumb({ thumbUrl: url = null, thumbAlt = '' }, { placeholder = false } = {}) {
    const box = singles.thumb;
    const img = box.querySelector('img');
    closeLarger();
    shownThumbUrl = url;
    if (url) {
      img.src = url;
      img.alt = thumbAlt;
      img.hidden = false;
      box.hidden = false;
    } else {
      img.removeAttribute('src');
      img.alt = '';
      img.hidden = true;
      box.hidden = !placeholder; // the striped box stands in while scanning
    }
  }

  /** "Show larger" closed: back to the small thumbnail, and the full image's URL is revoked. */
  function closeLarger() {
    const box = singles.thumb;
    box.classList.remove('is-large');
    if (largeUrl) {
      const img = box.querySelector('img');
      if (shownThumbUrl) img.src = shownThumbUrl; else img.removeAttribute('src');
      URL.revokeObjectURL(largeUrl);
      largeUrl = null;
    }
  }

  /** Object URL for the current (small) thumbnail; revoked when replaced or cleared. */
  function thumbnail(blob) {
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    thumbUrl = blob ? URL.createObjectURL(blob) : null;
    return thumbUrl;
  }

  function fillRead(c, { path }) {
    // Unknown grader with a ranked guess: the chip names the guess the form preselects (QA P2-7).
    const guess = c.grader ? null : (c.graderOptions ?? [])[0];
    readEls.chip.textContent = c.grader ? graderName(c.grader) : guess ? t('candidate_grader_guess', [graderName(guess)]) : t('candidate_grader_unknown');
    readEls.chip.dataset.unknown = String(!c.grader);
    readEls.chip.dataset.grader = c.grader ?? '';
    readEls.number.textContent = c.number;
    readEls.method.textContent = t(methodKey(c.method ?? c.source));
    setPath(readEls.path, path ?? '');
    readEls.path.hidden = !path;
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
    syncOpenLabel();
    return { form, input };
  }

  /** The form's primary button names the chosen (or best-guess) grader: "Open CGC Cards cert page" (G2). */
  function syncOpenLabel() {
    const form = singles.certform;
    const g = form.querySelector('input[name="task-grader"]:checked')?.value ?? '';
    ref(form, 'open-label').textContent = !g ? t('open_button') : hasDirectUrl(g) ? t('confirm_open_guess', [graderName(g)]) : t('open_lookup');
  }
  singles.certform.addEventListener('change', syncOpenLabel);
  singles.certform.addEventListener('input', syncOpenLabel);

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
    } else if (lowres.state === 'granted') {
      box.className = 'note note-box alert-success';
      setIcon('i-circle-check');
      title.textContent = t('perm_granted', [host]);
      bodyEl.hidden = true; actionsRow.hidden = true; fine.hidden = true; notNow.hidden = true;
      rescanRow.hidden = false;
      if (lowres.primary) rescanRow.querySelector('button').className = 'btn btn-strong btn-sm';
    } else if (lowres.state === 'denied') {
      box.className = 'note note-box';
      setIcon('i-circle-i');
      title.hidden = true;
      bodyEl.textContent = t('perm_denied', [host]);
      actionsRow.hidden = true; fine.hidden = true; notNow.hidden = true;
    } else if (lowres.state === 'failed') {
      box.className = 'note note-box note-warn';
      setIcon('i-circle-x');
      title.textContent = t('perm_failed');
      bodyEl.hidden = true; fine.hidden = true;
    }
    slot.appendChild(frag);
  }

  // ------------------------------------------------------------ states
  /** S0 (A9): "Scan this page" leads; right-click and shortcut hints follow. hint: {key, subs} | null */
  function showIdle({ focus = false, hint = null } = {}) {
    setTaskState('idle');
    setHeading(t('idle_heading'));
    const frag = clone('tpl-idle');
    body.appendChild(frag);
    updateIdleHint(hint);
    if (focus) heading.focus({ preventScroll: false });
  }

  /** Shortcut/icon hint in S0; changes with the toolbar setting and the shortcut (no re-render, focus stays). */
  function updateIdleHint(hint) {
    if (task.dataset.state !== 'idle') return;
    const el = ref(body, 'shortcut-hint');
    if (!el) return;
    el.textContent = hint ? t(hint.key, hint.subs) : '';
    el.hidden = !hint;
  }

  function showScanning({ caption = '', thumbUrl: url = null, thumbAlt = '', page = false } = {}) {
    setTaskState('scanning');
    setHeading(t('scan_heading'));
    stages = [];
    const frag = clone('tpl-scanning');
    ref(frag, 'caption').textContent = caption;
    body.appendChild(frag);
    setThumb({ thumbUrl: url, thumbAlt }, { placeholder: true });
    // Page mode (design v2): "Looking for slab photos…", then "Scanning image k of n" over a bar, without the photo steps.
    ref(body, 'scan-media').hidden = page;
    singles.pageprogress.hidden = !page;
    if (page) singles.pageprogress.textContent = t('page_finding');
    renderSteps();
    slowTimer = setTimeout(() => { const s = ref(body, 'slow'); if (s) s.hidden = false; }, SLOW_MS);
    settle(t(page ? 'status_page_started' : 'status_scan_started'));
  }

  /** A9 progress: {stage:'page-discover'} | {stage:'page', index, total}. Each new image restarts the step list. */
  function pageProgress(p) {
    if (task.dataset.state !== 'scanning') return;
    if (p.stage !== 'page') {
      singles.pageprogress.textContent = t('page_finding');
      return;
    }
    singles.pageprogress.textContent = t('page_progress', [String(p.index), String(p.total)]);
    const bar = ref(body, 'segbar');
    if (bar && Number.isInteger(p.total) && p.total > 0 && p.total <= 24) {
      bar.hidden = false;
      while (bar.firstChild) bar.firstChild.remove();
      for (let i = 1; i <= p.total; i++) {
        const seg = doc.createElement('span');
        seg.dataset.state = i < p.index ? 'done' : i === p.index ? 'active' : 'todo';
        bar.appendChild(seg);
      }
    }
    stages = [];
    renderSteps();
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

  /**
   * Result (layout A, docs/design/ui-candidates.md §3): the heading names the slab (grade badge + card name), then
   * Value, Cert check (how the number was read, the exact URL, Open again / Copy, the safety note) and Market.
   */
  function showResult(view, { moveFocus = true } = {}) {
    setTaskState('result');
    const o = view.opened;
    identity = { grader: o.grader, number: o.number, title: null, desc: view.prices?.desc || null };
    setHeading('');
    body.appendChild(clone('tpl-result'));
    fillRead({ grader: o.grader, number: o.number, method: o.method }, { path: displayUrl(o.url ?? buildCertUrl(o.grader, o.number)) });
    // Design v2: the cert check sits under the number: "✓ Opened <url>", how it was read below.
    ref(body, 'verify-url').appendChild(readEls.path);
    ref(body, 'verify-src').appendChild(readEls.method);
    ref(body, 'bg-note').hidden = !(o.background && Number.isInteger(o.tabId));
    renderVerify(o);
    // The (parked) grader control mirrors the opened grader so §13 readers see the routed grader in S2 too.
    for (const r of singles.certform.querySelectorAll('input[type="radio"]')) r.checked = r.value === o.grader;
    ref(singles.certform, 'graders').dataset.value = o.grader;
    setThumb(view);
    resetCopyLabel();
    offline(body);
    renderPrices(view.prices);
    extra.appendChild(clone('tpl-result-foot'));
    syncIdentity();
    reportBox(view.report);
    const said = o.lookupPending ? `${graderName(o.grader)} ${o.number}. ${t('verify_not_opened_bgs')}` : t(openedStatusKey(o.grader), [graderName(o.grader), o.number]);
    settle(said, { moveFocus });
    // The heading names the slab, not what happened: the outcome ("Opened … cert page") is always spoken (§2.2).
    if (status.textContent !== said) announce(said);
  }

  /** Cert check line: "✓ Opened <url>", or for Beckett before the click "Not opened yet" + what the button does. */
  function renderVerify(o) {
    const line = ref(body, 'verify-line');
    if (!line) return;
    const pending = Boolean(o.lookupPending);
    line.dataset.pending = String(pending);
    line.querySelector('use').setAttribute('href', pending ? '#i-circle-i' : '#i-check');
    ref(body, 'verify-text').textContent = t(pending ? 'verify_not_opened_bgs' : 'verify_opened');
    // Beckett before the click: no URL yet (its lookup form), only how the number was read.
    ref(body, 'verify-url').hidden = pending;
    ref(body, 'lookup-note').hidden = pending || hasDirectUrl(o.grader);
    const again = ref(body, 'open-again');
    again.classList.toggle('btn-strong', pending);
    again.classList.toggle('btn-secondary', !pending);
    ref(body, 'open-again-lead').toggleAttribute('hidden', pending);
    ref(body, 'open-again-trail').toggleAttribute('hidden', !pending);
    ref(body, 'open-again-label').textContent = t(pending ? 'open_lookup' : 'open_again');
    singles.copy.hidden = pending;
  }

  /** Beckett lookup opened from the result: the line, button and paste hint update in place; focus stays on the button. */
  function markLookupOpened(o) { renderVerify({ ...o, lookupPending: false }); }

  /** Heading text: PSA's or PriceCharting's card name, else the name read from the label, else "PSA 81234567". */
  function syncIdentity() {
    if (!identity || task.dataset.state !== 'result') return;
    const name = identity.title || identity.desc;
    headingText.textContent = name || t('identity_fallback', [graderName(identity.grader), identity.number]);
  }

  /** Grade badge in the heading: the slab's grade as read (label or PSA), not the grade chosen for prices; none while the
   * grade is unknown (design v2: "BGS 0012345678" without a chip). */
  function setBadge(grader, grade) {
    headingBadge.hidden = !grader || !grade;
    if (!headingBadge.hidden) headingBadge.textContent = gradeLabel(grader, grade);
  }

  /**
   * Value + Market under a result. prices: {grader, desc, grade, site}: search terms read from the label (or from PSA's
   * API) and the slab's grade. The data is filled by showPriceData(); "Wrong card or grade? Change" opens the fields,
   * and Show value or a new grade asks main.js for new prices (actions.pricesChanged).
   */
  function renderPrices(prices) {
    priceGrader = null;
    valueAnnounced = false;
    if (!prices || !GRADE_SCALES[prices.grader]) { setBadge(identity?.grader, null); return; }
    priceGrader = prices.grader;
    const comic = prices.grader === 'cgc-comics';
    const vf = clone('tpl-value');
    const mf = clone('tpl-market');
    const input = ref(vf, 'price-card');
    const select = ref(vf, 'price-grade');
    const fields = ref(vf, 'price-fields');
    const edit = ref(vf, 'price-edit');
    ref(vf, 'price-card-label').textContent = t(comic ? 'prices_title_label' : 'prices_card_label');
    ref(vf, 'price-edit-label').textContent = t(comic ? 'value_change_comic' : 'value_change');
    ref(vf, 'price-change').addEventListener('click', () => openPriceFields('card'));
    input.value = prices.desc ?? '';
    // Design v2: the slab's grades only ("All grades" gave an empty tile); "Choose a grade" while none was read.
    for (const g of ['', ...GRADE_SCALES[prices.grader]]) {
      const o = doc.createElement('option');
      o.value = g;
      o.textContent = g ? gradeLabel(prices.grader, g) : t('prices_grade_choose');
      if (!g) o.disabled = true;
      select.appendChild(o);
    }
    select.value = matchGrade(prices.grader, prices.grade) ?? '';
    input.addEventListener('input', () => showPriceError(''));
    select.addEventListener('change', () => showPriceError(''));
    // "Show value" applies the card and grade (user: "show value met grades werkt niet" - a new grade was looked up as
    // soon as it was picked, so the button itself seemed to do nothing): the form closes and the value loads again.
    fields.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input.value.trim()) { showPriceError(comic ? 'prices_need_title' : 'prices_need_card'); return; }
      if (!select.value) { showPriceError('prices_need_grade', 'grade'); return; }
      showPriceError('');
      setPriceFields(false);
      syncPriceSummary();
      ref(extra, 'price-edit')?.focus();
      actions.pricesChanged?.();
    });
    edit.addEventListener('click', () => {
      const open = fields.hidden;
      setPriceFields(open);
      if (open) input.focus();
    });
    ref(mf, 'price-pop').hidden = !POP_URLS[prices.grader];
    ref(vf, 'price-note').textContent = t('find_note', [ebayHostLabel(prices.site)]);
    const toggle = ref(mf, 'market-toggle');
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      ref(extra, 'market-data').hidden = !open;
    });
    extra.append(vf, mf);
    setPriceFields(false); // QA P2-6: the fields open only when the card name is missing (need-card) or on Change
    setBadge(prices.grader, select.value);
    syncPriceSummary();
  }

  /** Opens Change and puts the cursor in the card field or the grade list. */
  function openPriceFields(focus = 'card') {
    setPriceFields(true);
    const el = ref(extra, focus === 'grade' ? 'price-grade' : 'price-card');
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  }

  function setPriceFields(open) {
    const fields = ref(extra, 'price-fields');
    if (!fields) return;
    fields.hidden = !open;
    ref(extra, 'price-edit')?.setAttribute('aria-expanded', String(open));
  }

  /** "Matched" line under the tiles: PriceCharting's / PSA's name once known, else the search terms. */
  function syncPriceSummary(title = null) {
    const text = ref(extra, 'price-card-text');
    if (!text) return;
    const card = title ?? ref(extra, 'price-card').value.trim();
    text.textContent = card || t(priceGrader === 'cgc-comics' ? 'identity_title_unknown' : 'identity_card_unknown');
    text.classList.toggle('muted', !card);
  }

  /**
   * What the PSA key gave for this cert, under the identity: grade text and population, or why nothing came back
   * (key not accepted, daily limit, …). Shown whatever happens to the prices.
   */
  function showPsaInfo({ card = null, reason = null }) {
    const el = ref(body, 'psa-info');
    if (!el) return;
    const n = (v) => new Intl.NumberFormat(t('locale_code') || undefined).format(v);
    el.hidden = false;
    el.textContent = card
      ? (card.population != null ? t('psa_info_pop', [card.gradeText || '', n(card.population), n(card.populationHigher ?? 0)]) : t('psa_info_ok', [card.gradeText || '']))
      : t({
        auth: 'psa_info_auth', blocked: 'psa_info_blocked', server: 'psa_info_server', limit: 'psa_info_limit', 'no-permission': 'psa_info_no_permission',
        'not-found': 'psa_info_not_found',
      }[reason] ?? 'psa_info_error');
  }

  /** Card details from PSA's API (cert lookup) or from the label: search terms, grade and full title. */
  function applyCertCard(card) {
    const input = ref(extra, 'price-card');
    const select = ref(extra, 'price-grade');
    if (!input || !select) return;
    if (card.query) input.value = card.query;
    const g = matchGrade(priceGrader, card.grade);
    if (g) { select.value = g; setBadge(priceGrader, g); }
    if (identity) {
      if (card.title) identity.title = card.title;
      else if (card.query) identity.desc = card.query;
      syncIdentity();
    }
    syncPriceSummary(card.title || null);
  }

  /** Number and date formats, made once per kind (a price list formats every row). */
  const formats = new Map();
  const format = (key, make) => formats.get(key) ?? formats.set(key, make()).get(key);
  const locale = () => t('locale_code') || undefined;
  const money = (n, currency = 'USD') => format(`money:${currency}`, () => new Intl.NumberFormat(locale(), { style: 'currency', currency })).format(n);
  const saleDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d)
    ? format('date', () => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })).format(new Date(`${d}T00:00:00Z`))
    : d);

  const PRICE_STATE_KEY = {
    loading: 'prices_loading', reading: 'prices_reading', check: 'prices_checking', 'no-permission': 'prices_allow_text', 'not-found': 'prices_not_found',
    unreadable: 'prices_unreadable', error: 'prices_error', challenge: 'prices_challenge', 'need-card': 'prices_need_card_data',
  };
  /** States announced once through #status (a tab that opens, and the ones that need the user). */
  const ANNOUNCED_STATES = new Set(['check', 'not-found', 'unreadable', 'error', 'challenge']);

  const EBAY_STATE_KEY = {
    loading: 'ebay_loading', check: 'ebay_checking', 'no-permission': 'ebay_allow_text', blocked: 'ebay_blocked', error: 'ebay_error',
    'need-card': 'ebay_need_card', 'need-grade': 'ebay_need_grade', none: 'ebay_none',
  };

  /** A sale line: date · title · price (design v2: one line each, the title cut with an ellipsis). */
  function saleRow(list, { date, title, price, url = null }) {
    const li = doc.createElement('li');
    const d = doc.createElement('span');
    const v = doc.createElement('span');
    d.className = 'sale-date';
    v.className = 'sale-price';
    d.textContent = saleDate(date);
    v.textContent = price;
    let ti;
    if (url) {
      ti = doc.createElement('button');
      ti.type = 'button';
      ti.className = 'link sale-title';
      ti.dataset.action = 'ebay-item';
      ti.dataset.url = url;
      ti.textContent = title;
      const nt = doc.createElement('span');
      nt.className = 'visually-hidden';
      nt.textContent = ` ${t('a11y_new_tab')}`;
      ti.append(nt);
    } else {
      ti = doc.createElement('span');
      ti.className = 'sale-title';
      ti.textContent = title;
    }
    ti.title = title;
    li.append(d, ti, v);
    list.appendChild(li);
  }

  /**
   * eBay sales section (A21). st: {status:'off'} (setting off: only the eBay searches), a state from EBAY_STATE_KEY,
   * or the ok result of ebayData.loadEbay(); plus {label} (the grade asked for, "PSA 10") and {host} (the eBay site).
   */
  function showEbay(st) {
    const box = ref(extra, 'ebay-block');
    if (!box) return;
    const off = st.status === 'off';
    const ov = st.status === 'ok' ? st.overview : null;
    const status = ov && !ov.count && !ov.forSale ? 'none' : st.status;
    box.dataset.status = status;
    box.setAttribute('aria-busy', String(['loading', 'check'].includes(status)));
    ref(box, 'ebay-heading').textContent = off ? t('ebay_heading') : t('ebay_sales_heading', [keepTogether(st.label || '')]);
    const found = status === 'ok';
    ref(box, 'ebay-state').hidden = found || off;
    ref(box, 'ebay-found').hidden = !found;
    if (off) return;
    ref(box, 'ebay-spin').toggleAttribute('hidden', !['loading', 'check'].includes(status));
    ref(box, 'ebay-allow').hidden = status !== 'no-permission';
    ref(box, 'ebay-allow-label').textContent = t('ebay_allow');
    ref(box, 'ebay-retry').hidden = !['blocked', 'error'].includes(status);
    // Grade or card name not read: the button opens Change with that field focused (user: "kies hierboven de grade, maar
    // ik zie niks staan" - the fields are folded away under Change).
    const pick = ref(box, 'ebay-pick');
    pick.hidden = !['need-grade', 'need-card'].includes(status);
    pick.dataset.focus = status === 'need-grade' ? 'grade' : 'card';
    ref(box, 'ebay-pick-label').textContent = t(status === 'need-grade' ? 'ebay_pick_grade' : 'ebay_pick_card');
    if (!found) {
      ref(box, 'ebay-state-text').textContent = t(EBAY_STATE_KEY[status] ?? 'ebay_error', [status === 'no-permission' ? (st.host ?? '') : keepTogether(st.label || '')]);
      if (['check', 'blocked'].includes(status)) announce(t(EBAY_STATE_KEY[status]));
      return;
    }
    const cur = ov.currency;
    ref(box, 'ebay-last').textContent = ov.last ? money(ov.last.price.value, cur) : '—';
    ref(box, 'ebay-last-date').textContent = ov.last ? saleDate(ov.last.soldDate) : '';
    ref(box, 'ebay-median-label').textContent = t('ebay_median_label', [String(ov.count)]);
    ref(box, 'ebay-median').textContent = ov.median != null ? money(ov.median, cur) : '—';
    ref(box, 'ebay-low').textContent = ov.forSale ? money(ov.forSale.low.price.value, cur) : '—';
    ref(box, 'ebay-low-count').textContent = ov.forSale ? t('ebay_offers_count', [String(ov.forSale.count)]) : '';
    const list = ref(box, 'ebay-sales');
    while (list.firstChild) list.firstChild.remove();
    for (const s of ov.sales.slice(0, SHOWN_EBAY_SALES)) saleRow(list, { date: s.soldDate, title: s.title, price: money(s.price.value, cur), url: s.url });
  }

  /** "Price per grade" preview while folded: the grade below this slab's, the highest price, and how many more. */
  function marketPreview(prices, current) {
    if (!prices.length) return '';
    const at = current ? prices.findIndex((p) => p.label === current.label) : -1;
    const picks = [];
    if (at > 0) picks.push(prices.at(at - 1));
    const top = prices.reduce((a, b) => (b.price > a.price ? b : a));
    const own = at >= 0 ? prices.at(at) : null;
    if (top !== own && !picks.includes(top)) picks.push(top);
    if (!picks.length) picks.push(prices[0]);
    const more = prices.length - picks.length - (at >= 0 ? 1 : 0);
    return [...picks.map((p) => `${p.label} ${money(p.price)}`), ...(more > 0 ? [t('market_more', [String(more)])] : [])].join(' · ');
  }

  /**
   * Value section (+ Price per grade). st: {status:'loading'|'reading'|'no-permission'|'not-found'|'unreadable'|'error'|
   * 'challenge'|'need-card'} or an ok result (source 'pc': priceData.loadPrices(), 'ppt': pptApi.loadPptPrices()) plus
   * {psa} (PSA API card with population) and {note} (why PokemonPriceTracker wasn't used, e.g. its daily limit).
   */
  function showPriceData(st) {
    const box = ref(extra, 'price-data');
    const market = ref(extra, 'market');
    if (!box) return;
    const ok = st.status === 'ok';
    const comic = priceGrader === 'cgc-comics';
    const busy = ['loading', 'reading', 'check'].includes(st.status);
    box.setAttribute('aria-busy', String(busy));
    box.dataset.status = st.status;
    ref(box, 'price-state').hidden = ok;
    ref(box, 'price-found').hidden = !ok;
    if (market) market.hidden = !ok;
    ref(box, 'price-spin').toggleAttribute('hidden', !busy);
    ref(box, 'price-allow').hidden = st.status !== 'no-permission';
    ref(box, 'price-change').hidden = !['need-card', 'not-found'].includes(st.status);
    ref(box, 'price-retry').hidden = !['error', 'challenge', 'unreadable'].includes(st.status);
    ref(box, 'price-pc-search').hidden = !['challenge', 'unreadable', 'not-found'].includes(st.status);
    ref(extra, 'value-match').hidden = !ok && st.status === 'need-card';
    ref(extra, 'value-source').textContent = ok ? t(st.source === 'ppt' ? 'value_source_ppt' : 'value_source') : '';
    const notes = st.note ? [t(st.note.key, st.note.subs)] : [];
    const col = ref(extra, 'pc-col');
    const showNotes = () => { col.textContent = notes.join(' · '); col.hidden = !notes.length; };
    if (!ok) {
      showNotes();
      const q = ref(extra, 'price-card')?.value.trim() ?? '';
      const key = st.status === 'need-card' && comic ? 'prices_need_title_data' : (PRICE_STATE_KEY[st.status] ?? 'prices_error');
      ref(box, 'price-state-text').textContent = t(key, [q]);
      if (ANNOUNCED_STATES.has(st.status)) announce(t(key, [q]));
      return;
    }
    const set = ref(body, 'price-set');
    if (st.name) {
      syncPriceSummary(st.name);
      if (identity && !identity.title) { identity.title = st.name; syncIdentity(); }
    }
    if (set) {
      set.textContent = st.set ? t('prices_set_line', [st.set]) : '';
      set.hidden = !st.set;
    }
    // Tiles name the grade asked for (e.g. "PSA 9"); PriceCharting's own column name is shown when it differs.
    const grade = ref(extra, 'price-grade')?.value ?? '';
    const pcLabel = st.current?.label ?? st.labels?.[0] ?? '';
    const asked = grade ? gradeLabel(priceGrader, grade) : '';
    const label = asked || pcLabel;
    if (!grade) notes.push(t('value_pick_grade'));
    else if (st.current && pcLabel && pcLabel.toLowerCase() !== asked.toLowerCase()) notes.push(t('value_column', [pcLabel]));
    showNotes();
    if (market) ref(market, 'price-pc-open').hidden = !st.url;
    ref(box, 'pc-label').textContent = label ? t('prices_current_label', [keepTogether(label)]) : t('prices_current_unknown');
    ref(box, 'pc-price').textContent = st.current ? money(st.current.price) : '—';
    // Second tile: the newest single sale; PokemonPriceTracker plans without single sales give the median sale instead.
    const sum = !st.lastSold && st.soldSummary?.median ? st.soldSummary : null;
    const gradeText = keepTogether(label || t('prices_grade_all'));
    ref(box, 'pc-last-label').textContent = t(sum ? 'prices_median_label' : 'prices_last_sold_label', [gradeText]);
    ref(box, 'pc-last').textContent = st.lastSold ? money(st.lastSold.price) : sum ? money(sum.median) : '—';
    ref(box, 'pc-last-date').textContent = st.lastSold ? saleDate(st.lastSold.date)
      : sum ? [sum.count ? t('prices_sales_count', [String(sum.count)]) : '', sum.lastDate ? t('prices_last_on', [saleDate(sum.lastDate)]) : ''].filter(Boolean).join(' · ')
        : t('prices_no_recent');
    if (market) {
      ref(market, 'market-preview').textContent = marketPreview(st.prices, st.current);
      const grid = ref(market, 'pc-grid');
      while (grid.firstChild) grid.firstChild.remove();
      for (const p of st.prices) {
        const li = doc.createElement('li');
        const l = doc.createElement('span');
        const v = doc.createElement('strong');
        l.textContent = p.label;
        v.textContent = money(p.price);
        li.append(l, v);
        if (st.current && p.label === st.current.label) {
          li.dataset.current = 'true';
          const sr = doc.createElement('span');
          sr.className = 'visually-hidden';
          sr.textContent = ` ${t('grid_current_sr')}`;
          li.append(sr);
        }
        grid.appendChild(li);
      }
      const list = ref(market, 'pc-sales');
      while (list.firstChild) list.firstChild.remove();
      const rows = st.sales?.rows ?? [];
      ref(market, 'pc-sales-heading').textContent = t('prices_sales_heading', [st.sales?.label ?? label]);
      for (const r of rows) saleRow(list, { date: r.date, title: r.title, price: money(r.price) });
      const none = ref(market, 'pc-no-sales');
      none.hidden = rows.length > 0;
      none.textContent = t('prices_no_sales', [label || t('prices_grade_all')]);
    }
    // One spoken summary per result (D6): the grid and sales list are not a live region.
    if (!valueAnnounced) {
      valueAnnounced = true;
      const name = identity?.title || identity?.desc || '';
      const cur = st.current ? money(st.current.price) : '—';
      const g = label || t('prices_grade_all');
      announce(st.lastSold ? t('status_value', [name, g, cur, money(st.lastSold.price)])
        : sum ? t('status_value_median', [name, g, cur, money(sum.median)])
          : t('status_value_no_sale', [name, g, cur]));
    }
  }

  /** What the price block searches for: {grader, desc, grade} (grade '' = all grades). */
  function priceInput() {
    return { grader: priceGrader, desc: (ref(extra, 'price-card')?.value ?? '').trim(), grade: ref(extra, 'price-grade')?.value ?? '' };
  }

  /** Error under the card field, focus on the field; an empty key clears it. */
  function showPriceError(key, field = 'card') {
    const err = ref(extra, 'price-error');
    const input = ref(extra, 'price-card');
    const select = ref(extra, 'price-grade');
    if (!err || !input) return;
    err.textContent = key ? t(key) : '';
    input.removeAttribute('aria-invalid');
    select?.removeAttribute('aria-invalid');
    if (key) {
      setPriceFields(true);
      const el = field === 'grade' ? select : input;
      el.setAttribute('aria-invalid', 'true');
      el.focus();
    }
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

  /** S2e. method: how the number was read (shown above the form). */
  function showEdit({ number, grader, method = null }) {
    setTaskState('edit');
    setHeading(t('edit_heading'));
    body.appendChild(clone('tpl-edit'));
    const m = ref(body, 'edit-method');
    m.textContent = method ? t(methodKey(method)) : '';
    m.hidden = !method;
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
    setHeading(t('confirm_heading'), 'warning');
    body.appendChild(clone('tpl-confirm'));
    ref(body, 'back-to-page').hidden = !view.backToPage;
    // Design v2: one grey box with every reason; what to check gets a red triangle, what only informs a grey "i".
    // An off-site QR code is the first reason, with its title.
    const reasons = ref(body, 'reasons');
    const addReason = (tone, text, title = null) => {
      const frag = clone('tpl-reason');
      frag.querySelector('.reason').dataset.tone = tone;
      ref(frag, 'reason-icon').setAttribute('href', tone === 'warning' ? '#i-triangle' : '#i-circle-i');
      const head = ref(frag, 'reason-title');
      head.textContent = title ?? '';
      head.hidden = !title;
      ref(frag, 'reason-text').appendChild(doc.createTextNode(text));
      reasons.appendChild(frag);
    };
    if (view.qrHost) addReason('warning', [t('qr_offsite_body', [view.qrHost]), view.qrNumberUsed ? t('qr_offsite_number') : ''].filter(Boolean).join(' '), t('qr_offsite_title'));
    for (const r of view.reasons) addReason(INFO_REASONS.has(r.key) ? 'info' : 'warning', t(r.key, r.subs));
    reasons.hidden = !reasons.firstChild;
    setThumb(view);
    const larger = ref(body, 'larger');
    larger.hidden = !view.thumbUrl;
    ref(body, 'larger-label').textContent = t('image_larger');
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
        const row = cf.querySelector('.candidate');
        const use = ref(cf, 'use');
        row.dataset.testid = `candidate-${i}`;
        const num = ref(cf, 'number');
        num.id = `cand-${i}-number`;
        num.textContent = c.number;
        ref(cf, 'best').hidden = i !== 0;
        const meta = [t(methodKey(c.source)), c.grader ? t('candidate_grader_guess', [graderName(c.grader)]) : t('candidate_grader_unknown')];
        ref(cf, 'meta').textContent = meta.join(' · ');
        const label = ref(cf, 'use-label');
        label.id = `cand-${i}-use`;
        label.textContent = !c.grader ? t('candidate_use') : hasDirectUrl(c.grader) ? t('confirm_open_guess', [graderName(c.grader)]) : t('open_lookup');
        use.dataset.index = String(i);
        use.setAttribute('aria-labelledby', `${label.id} ${num.id}`);
        if (i === 0) use.classList.add('is-best');
        items.appendChild(cf);
      });
    }
    mountForm({ ...view.prefill, withCopy: true, cgcHint: !view.reasons.some((r) => r.key === 'reason_cgc_both') });
    // Several numbers: each row continues with its number; the form comes back when a row needs a grader (design v2).
    singles.certform.hidden = cands.length >= 2;
    renderLowres(ref(body, 'lowres-slot'), view.lowres);
    reportBox(view.report);
    offline(body);
    const summary = [t('confirm_heading'), view.reasons[0] ? t(view.reasons[0].key, view.reasons[0].subs) : ''].filter(Boolean).join('. ');
    settle(summary, { moveFocus });
  }

  /**
   * "Show larger" / "Show smaller". `fullBlob`: the original image; its object URL exists only while the large view
   * is open (perf rec. 1). Without it the small thumbnail is shown larger.
   */
  function toggleLarger(fullBlob = null) {
    const box = singles.thumb;
    const btn = ref(body, 'larger');
    if (!btn) return;
    const large = !box.classList.contains('is-large');
    if (large) {
      if (fullBlob) {
        largeUrl = URL.createObjectURL(fullBlob);
        box.querySelector('img').src = largeUrl;
      }
      box.classList.add('is-large');
    } else {
      closeLarger();
    }
    btn.setAttribute('aria-expanded', String(large));
    ref(btn, 'larger-label').textContent = t(large ? 'image_smaller' : 'image_larger');
  }

  /** "This went wrong" (A20): offered only while the scanned photo and its result are in memory (not after a restore). */
  function reportBox(on) {
    const box = refAny('report-box');
    if (box) box.hidden = !on;
  }

  /** The report file was handed to the browser's download: the hint names it, and it is announced. */
  function reportSaved(fileName) {
    const hint = refAny('report-hint');
    const text = t('report_saved', [fileName]);
    if (hint) { hint.textContent = text; hint.hidden = false; }
    announce(text);
  }

  /** S4. view: {thumbUrl, thumbAlt, qrHost, lowres, ocrUnavailable, report} */
  function showNone(view, { moveFocus = true } = {}) {
    setTaskState('none');
    setHeading(t('none_heading'), 'info');
    body.appendChild(clone('tpl-none'));
    setThumb(view);
    qrBlock(body, view.qrHost, false);
    ref(body, 'ocr-note').hidden = !view.ocrUnavailable;
    renderLowres(ref(body, 'lowres-slot'), view.lowres);
    reportBox(view.report);
    settle(t('none_heading'), { moveFocus });
  }

  /** S5. ev = errorView(...) */
  function showError(ev, { code, moveFocus = true } = {}) {
    setTaskState('error');
    setHeading(t(ev.heading), ev.tone);
    const frag = clone('tpl-error');
    let first = true;
    for (const b of frag.querySelectorAll('[data-action]')) {
      b.hidden = !ev.actions.includes(b.dataset.action);
      b.className = `btn ${!b.hidden && first ? 'btn-strong' : 'btn-secondary'}`; // design v2: the first way out leads
      if (!b.hidden) first = false;
    }
    body.appendChild(frag);
    const p = singles.error;
    p.textContent = t(ev.body, ev.bodySubs);
    p.dataset.code = code ?? '';
    p.dataset.errorId = ev.id;
    settle(`${t(ev.heading)}. ${t(ev.body, ev.bodySubs)}`, { moveFocus });
  }

  /**
   * A9 results list. view: {items, thumbs:string[], qrHost, qrNumberUsed, summary:[{key,subs}], opened:Set<number>};
   * handlers: {onOpen, onChoose, onCopy, onPrices}. Each row shows the number, grader, how it was read and the exact URL
   * that Open will load.
   */
  function showPageResults(view, handlers, { moveFocus = true } = {}) {
    setTaskState('page-results');
    setHeading(t('page_results_heading'), 'info');
    const frag = clone('tpl-page-results');
    const summary = ref(frag, 'summary');
    for (const line of view.summary ?? []) {
      const p = doc.createElement('p');
      p.textContent = t(line.key, line.subs);
      summary.appendChild(p);
    }
    body.appendChild(frag);
    // QA P2-9: the off-site QR warning once — in the row that used its number, else above the list.
    if (!view.items.some((item) => pageRowNote(item)?.key === 'page_row_offsite')) qrBlock(body, view.qrHost, view.qrNumberUsed);
    // Rows in page order (photo 1, 2, …); `i` stays the aggregate index used by the handlers and test ids.
    const order = view.items.map((item, i) => ({ item, i })).sort((a, b) => (a.item.imageIndex - b.item.imageIndex) || (a.i - b.i));
    order.forEach(({ item, i }) => {
      const row = clone('tpl-page-row');
      const li = row.querySelector('li');
      li.dataset.testid = `page-result-${i}`;
      li.dataset.number = item.number;
      li.dataset.grader = item.grader ?? '';
      const ids = (n) => `page-${i}-${n}`;
      const chip = ref(row, 'chip');
      const number = ref(row, 'number');
      chip.id = ids('chip');
      number.id = ids('number');
      chip.textContent = item.grader ? graderName(item.grader) : t('candidate_grader_unknown');
      chip.dataset.unknown = String(!item.grader);
      number.textContent = item.number;
      const note = pageRowNote(item);
      ref(row, 'meta').textContent = t(note?.key === 'page_row_offsite' ? 'method_qr' : methodKey(item.source));
      if (note) {
        const el = ref(row, 'note');
        el.hidden = false;
        el.dataset.tone = note.tone;
        ref(el, 'note-text').textContent = t(note.key, note.subs);
      }
      const path = ref(row, 'path');
      const thumb = view.thumbs?.[item.imageIndex];
      if (thumb) {
        const img = ref(row, 'thumb');
        img.src = thumb;
        img.alt = t('page_result_photo', [String(item.imageIndex + 1)]);
        img.hidden = false;
      }
      const open = ref(row, 'open');
      const choose = ref(row, 'choose');
      const copy = ref(row, 'copy');
      ref(row, 'open-label').id = ids('open');
      ref(row, 'choose-label').id = ids('choose');
      ref(row, 'copy-label').id = ids('copy');
      if (item.grader) {
        setPath(path, displayUrl(buildCertUrl(item.grader, item.number)));
        open.setAttribute('aria-labelledby', `${ids('open')} ${ids('chip')} ${ids('number')}`);
        open.addEventListener('click', () => handlers.onOpen(item, i));
      } else {
        path.hidden = true;
        open.hidden = true;
        choose.hidden = false;
        choose.setAttribute('aria-labelledby', `${ids('choose')} ${ids('number')}`);
        choose.addEventListener('click', () => handlers.onChoose(item, i));
      }
      copy.setAttribute('aria-labelledby', `${ids('copy')} ${ids('number')}`);
      copy.title = `${t('recent_copy')} ${item.number}`;
      copy.addEventListener('click', () => handlers.onCopy(item, i));
      const prices = ref(row, 'prices');
      ref(row, 'prices-label').id = ids('prices');
      if (item.grader && handlers.onPrices) {
        prices.setAttribute('aria-labelledby', `${ids('prices')} ${ids('chip')} ${ids('number')}`);
        prices.addEventListener('click', () => handlers.onPrices(item, i));
      } else {
        prices.hidden = true;
      }
      singles.pageresults.appendChild(row);
      if (view.opened?.has(i)) markPageOpened(i);
    });
    offline(body);
    settle([t('page_results_heading'), ...(view.summary ?? []).map((l) => t(l.key, l.subs))].join('. '), { moveFocus });
  }

  /** A row whose cert page was opened from the list shows "✓ Opened" in place of its Open button (design v2). */
  function markPageOpened(i) {
    const li = singles.pageresults.querySelector(`[data-testid="page-result-${i}"]`);
    if (!li) return;
    li.dataset.opened = 'true';
    const mark = ref(li, 'opened');
    if (mark) mark.hidden = false;
    const open = ref(li, 'open');
    if (open && li.contains(doc.activeElement) && doc.activeElement === open) ref(li, 'copy')?.focus();
    if (open) open.hidden = true;
  }

  /**
   * A9 none: no slab-sized photos, or photos checked without a readable number (O10: "Checked 8 of 10 photos…" when
   * the cap left some unchecked); tips follow. view.reason: {key, subs}.
   */
  function showPageNone(view, { moveFocus = true } = {}) {
    setTaskState('none');
    setHeading(t('page_none_heading'), 'info');
    const frag = clone('tpl-page-none');
    const reason = view.reason ?? { key: view.discovered ? 'page_none_checked' : 'page_none_no_images', subs: [] };
    ref(frag, 'none-reason').textContent = t(reason.key, reason.subs);
    ref(frag, 'tip-right-click').textContent = t('page_tip_right_click', [t('context_menu_scan')]);
    body.appendChild(frag);
    qrBlock(body, view.qrHost, false);
    settle(t('page_none_heading'), { moveFocus });
  }

  /**
   * A9: the panel button can't read the active tab. Explains the icon/shortcut (body: {key, subs}) and offers
   * "Always allow on ‹host›" when the panel knows the tab's https host, else (all) "Always allow on all sites".
   */
  function showPageAccess({ host = null, all = false, body: copy }, { moveFocus = true } = {}) {
    setTaskState('page-access');
    setHeading(t('page_access_heading'), 'warning');
    const frag = clone('tpl-page-access');
    ref(frag, 'access-body').textContent = t(copy.key, copy.subs);
    if (host || all) {
      ref(frag, 'always').hidden = false;
      ref(frag, 'always-label').textContent = host ? t('page_access_always', [host]) : t('page_access_always_all');
      ref(frag, 'always-fine').textContent = host ? t('page_access_fineprint') : t('page_access_fineprint_all');
      if (host) frag.querySelector('[data-action="always-allow"]').title = host;
    }
    body.appendChild(frag);
    settle(`${t('page_access_heading')}. ${ref(body, 'access-body').textContent}`, { moveFocus });
  }

  /** Access body text after a settings/shortcut change, without re-rendering (focus stays). */
  function updateAccessBody(copy) {
    if (task.dataset.state !== 'page-access') return;
    const el = ref(body, 'access-body');
    if (el) el.textContent = t(copy.key, copy.subs);
  }

  /** E12 (O11) body after a settings/shortcut change, without re-rendering (focus stays). */
  function updateNoAccessBody(copy) {
    if (task.dataset.state !== 'error' || singles.error.dataset.code !== 'page-no-access') return;
    singles.error.textContent = t(copy.key, copy.subs);
  }

  /** "Always allow" outcome: 'denied' (neutral note, offer withdrawn) or 'failed' (error, button stays). Focus goes to the note. */
  function setAccessOffer(state, host) {
    if (task.dataset.state !== 'page-access') return;
    const note = ref(body, 'always-status');
    if (!note) return;
    if (state === 'denied') {
      ref(body, 'always').hidden = true;
      note.className = 'note';
      ref(note, 'always-status-text').textContent = host ? t('page_access_denied', [host]) : t('page_access_denied_all');
    } else {
      note.className = 'note note-warn';
      ref(note, 'always-status-text').textContent = t('perm_failed');
    }
    note.hidden = false;
    note.focus();
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

  /** Settings: the page-scan shortcut as Chrome reports it ('' = not set). */
  function renderShortcut(shortcut) {
    const kbd = ref(singles.pagescan, 'kbd');
    kbd.textContent = shortcut || '';
    kbd.hidden = !shortcut;
    const cur = $('shortcut-current');
    cur.textContent = '';
    const text = shortcut ? t('setting_shortcut_current', [shortcut]) : t('setting_shortcut_unset');
    const at = shortcut ? text.indexOf(shortcut) : -1;
    if (at < 0) { cur.textContent = text; return; }
    const keys = doc.createElement('span');
    keys.className = 'kbd';
    keys.textContent = shortcut;
    cur.append(text.slice(0, at), keys, text.slice(at + shortcut.length)); // "Keyboard shortcut: " + keys in mono
  }

  function renderSettings(s, { historyCount }) {
    $('setting-scan-on-click').checked = s.scanOnToolbarClick !== false;
    $('setting-always-ask').checked = !s.autoOpen;
    $('setting-background').checked = Boolean(s.openInBackground);
    $('setting-history').checked = Boolean(s.saveHistory);
    $('setting-ebay-site').value = s.ebaySite ?? 'com';
    $('setting-ebay-sold').checked = s.ebaySold !== false;
    $('setting-read-via-tab').checked = s.readViaTab !== false;
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
    openOtherWays,
    announce, setBodyState, thumbnail, progress, updateScanThumb, toggleLarger, toggleRecent, lowresFocus, renderLowres,
    showIdle, showScanning, showResult, markLookupOpened, showPsaInfo, priceInput, showPriceError, showPriceData, showEbay, openPriceFields, applyCertCard, showOpenError, showCopyState, showEdit, showConfirm, showNone, showError,
    reportSaved,
    pageProgress, showPageResults, markPageOpened, showPageNone, showPageAccess, updateAccessBody, updateNoAccessBody, setAccessOffer, updateIdleHint,
    renderRecent, renderSettings, renderSites, renderShortcut,
    get field() { return field; },
    get taskState() { return task.dataset.state; },
  };
}
