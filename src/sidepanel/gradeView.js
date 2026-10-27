// Grade check view (raw cards): front and back photos in, centering and per-grader limits out, plus the optional AI
// check of corners, edges and surface. Lives in <main id="grade">; main.js shows it (showView('grade')) and hands it
// photos (drop, paste, Choose image, the context menu). Everything is rendered with textContent / DOM nodes only.
import { createGradeEngine, preparePhoto, cardJpeg } from './gradeEngine.js';
import { centeringFrom, ratioText, manualSide, SIDES } from '../pipeline/grade/measure.js';
import { estimateGrades, combineWear, mergeCondition, CONDITION_AREAS } from '../core/gradeEstimate.js';
import { GRADERS, GRADER_ORDER, STANDARDS_AS_OF } from '../core/gradeStandards.js';
import { PROVIDERS, VENDORS, loadKey, hasConsent, saveConsent, checkCondition, CLAUDE_IMAGE_SIDE, XIMILAR_IMAGE_SIDE } from './gradeAi.js';
import { classifyFile } from './inputs.js';

const PHOTO_SIDES = ['front', 'back'];
const WEAR_CORNERS = ['tl', 'tr', 'br', 'bl'];
const CORNER_R_MM = 3.2;
const blankSide = () => ({ status: 'empty', key: null, input: null, previewUrl: null, size: null, result: null, card: null, manual: {}, error: null, run: 0, ctl: null });
const fmtGrade = (g) => (Number.isInteger(g) ? String(g) : g.toFixed(1));
const ERROR_KEYS = {
  'too-large': 'grade_err_too_large', 'invalid-image': 'grade_err_invalid', timeout: 'grade_err_failed', failed: 'grade_err_failed',
};
const errorKey = (reason) => ERROR_KEYS[reason] ?? 'grade_err_fetch';

/**
 * @param {{doc:Document, t:(k:string, s?:string[])=>string, announce:(s:string)=>void, getProvider:()=>string,
 *   openSettings:(focusId:string)=>void, openTab:(url:string)=>void, chromeApi?:typeof chrome, engine?:object}} o
 */
export function createGradeView({ doc, t, announce, getProvider, openSettings, openTab, chromeApi = globalThis.chrome, engine = createGradeEngine() }) {
  const $ = (id) => doc.getElementById(id);
  const root = $('grade');
  const fileInput = $('grade-file');
  const sides = { front: blankSide(), back: blankSide() };
  let selected = 'front';
  let pendingSide = null;
  let keySeq = 0;
  let drawn = null; // the card currently painted on the canvas
  let corners = null; // {side, pts: fractions of the photo [[x, y] x4]}
  const ai = { state: 'idle', result: null, status: null, ctl: null, run: 0 };

  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  /** An icon from the sprite (cloned from a template, so no markup strings are parsed). */
  const icon = (id) => {
    const svg = doc.getElementById('tpl-grade-icon').content.firstElementChild.cloneNode(true);
    svg.querySelector('use').setAttribute('href', `#${id}`);
    return svg;
  };
  const button = (cls, text, onClick, testid) => {
    const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', onClick);
    if (testid) b.dataset.testid = testid;
    return b;
  };

  // ------------------------------------------------------------ measurement state

  /** Centering of one side with the lines the user moved by hand. */
  function centeringOf(name) {
    const s = sides[name];
    if (s.status !== 'done' || !s.result?.borders) return null;
    const { borders } = s.result;
    const eff = {};
    for (const n of SIDES) eff[n] = s.manual[n] !== undefined ? manualSide(s.manual[n], borders.pxPerMm) : borders.sides[n];
    return { ...centeringFrom(eff, { scale: s.card?.scale ?? 1, sysPx: s.result.source === 'image-edges' ? 2 : 0.5 }), sides: eff };
  }

  function sideText(name) {
    const s = sides[name];
    if (s.status === 'empty') return t('grade_slot_empty');
    if (s.status === 'loading') return t('grade_measuring');
    if (s.status === 'error') return t(errorKey(s.error));
    if (s.result.status === 'no-card') return t('grade_state_no_card');
    const c = centeringOf(name);
    if (!c?.lr && !c?.tb) return t('grade_state_no_border');
    return [c.lr && ratioText(c.lr.pct), c.tb && ratioText(c.tb.pct)].filter(Boolean).join(' · ');
  }

  function resetAi() {
    ai.ctl?.abort();
    ai.state = 'idle'; ai.result = null; ai.status = null;
  }

  async function measure(name, { input = null, quad = null } = {}) {
    const s = sides[name];
    s.ctl?.abort();
    const ctl = new AbortController();
    s.ctl = ctl;
    const run = ++s.run;
    s.status = 'loading'; s.error = null;
    render();
    try {
      let image = null;
      if (input) {
        const prep = await preparePhoto(input, { signal: ctl.signal });
        if (run !== s.run) return;
        if (!prep.ok) {
          // The new photo can't be used: the slot shows that, not the previous photo.
          if (s.key) engine.forget(s.key);
          if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
          Object.assign(s, { ...blankSide(), run: s.run, status: 'error', error: prep.reason });
          resetAi();
          render();
          announce(t(errorKey(prep.reason)));
          return;
        }
        if (s.key) engine.forget(s.key);
        if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
        Object.assign(s, { key: `p${++keySeq}`, input: { kind: 'blob', blob: prep.blob, method: input.method ?? 'upload' }, previewUrl: URL.createObjectURL(prep.preview), size: prep.size, manual: {} });
        image = prep.image;
        resetAi();
      }
      let result;
      try {
        result = await engine.analyze(s.key, { image, quad, signal: ctl.signal });
      } catch (e) {
        if (ctl.signal.aborted || image) throw e;
        // The worker was restarted (timeout or crash) and lost the photo: send it once more.
        const again = await preparePhoto(s.input, { signal: ctl.signal });
        if (!again.ok) throw e;
        result = await engine.analyze(s.key, { image: again.image, quad, signal: ctl.signal });
      }
      if (run !== s.run) return;
      s.result = result;
      s.card = result.card ?? null;
      s.status = 'done';
      if (quad) s.manual = {};
      corners = null;
      selected = name;
      render();
      announce(`${t(name === 'front' ? 'grade_front' : 'grade_back')}: ${sideText(name)}`);
      if (result.status === 'no-card') openCorners(name);
    } catch (e) {
      if (ctl.signal.aborted || run !== s.run) return;
      s.status = 'error';
      s.error = e?.message === 'timeout' ? 'timeout' : 'failed';
      render();
      announce(t(errorKey(s.error)));
    }
  }

  /** Which slot a new photo goes to: the one asked for, else the selected empty one, else front, else back, else selected. */
  function slotFor(side) {
    if (side && PHOTO_SIDES.includes(side)) return side;
    if (sides[selected].status === 'empty') return selected;
    return PHOTO_SIDES.find((n) => sides[n].status === 'empty') ?? selected;
  }

  function addInput(input, side = null) {
    $('grade-error').textContent = '';
    const name = slotFor(side);
    selected = name;
    measure(name, { input });
  }

  function addFile(file, method, side = null) {
    if (classifyFile(file) !== 'image') { $('grade-error').textContent = t('grade_err_invalid'); return; }
    addInput({ kind: 'blob', blob: file, method }, side);
  }

  function remove(name) {
    const s = sides[name];
    s.ctl?.abort();
    if (s.key) engine.forget(s.key);
    if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
    sides[name] = blankSide();
    if (corners?.side === name) corners = null;
    resetAi();
    render();
  }

  function swap() {
    [sides.front, sides.back] = [sides.back, sides.front];
    selected = selected === 'front' ? 'back' : 'front';
    corners = null;
    resetAi();
    render();
    announce(t('grade_swapped'));
  }

  // ------------------------------------------------------------ rendering

  function renderSlots() {
    for (const name of PHOTO_SIDES) {
      const s = sides[name];
      const slot = root.querySelector(`.grade-slot[data-side="${name}"]`);
      slot.dataset.filled = String(s.status !== 'empty');
      slot.dataset.selected = String(selected === name && s.status !== 'empty');
      slot.querySelector('.grade-slot-main').setAttribute('aria-pressed', String(selected === name));
      const img = slot.querySelector('[data-ref="img"]');
      img.hidden = !s.previewUrl;
      if (s.previewUrl && img.getAttribute('src') !== s.previewUrl) img.src = s.previewUrl;
      if (!s.previewUrl) img.removeAttribute('src');
      slot.querySelector('[data-ref="ph"]').toggleAttribute('hidden', Boolean(s.previewUrl));
      slot.querySelector('[data-ref="state"]').textContent = sideText(name);
      slot.querySelector('[data-action="grade-remove"]').hidden = s.status === 'empty';
      slot.querySelector('[data-action="grade-choose"] span').textContent = t(s.status === 'empty' ? 'upload_button' : 'grade_replace');
    }
    // Not while a side is being measured: its result belongs to the side it was taken for.
    $('grade-swap').hidden = (sides.front.status === 'empty' && sides.back.status === 'empty') || PHOTO_SIDES.some((n) => sides[n].status === 'loading');
  }

  function linePct(name, card, px) {
    if (name === 'left') return (px / card.width) * 100;
    if (name === 'right') return ((card.width - px) / card.width) * 100;
    if (name === 'top') return (px / card.height) * 100;
    return ((card.height - px) / card.height) * 100;
  }

  function placeLines(s, c) {
    const { card } = s;
    for (const line of root.querySelectorAll('.grade-line')) {
      const name = line.dataset.line;
      const side = c?.sides?.[name];
      line.hidden = !side?.ok;
      if (!side?.ok) continue;
      const pct = linePct(name, card, side.px);
      if (name === 'left' || name === 'right') line.style.left = `${pct}%`; else line.style.top = `${pct}%`;
      line.dataset.manual = String(s.manual[name] !== undefined);
      const mm = side.px / s.result.borders.pxPerMm;
      line.setAttribute('aria-valuemin', '0');
      line.setAttribute('aria-valuemax', String(Math.round(((name === 'left' || name === 'right' ? card.width : card.height) * 0.4) / s.result.borders.pxPerMm)));
      line.setAttribute('aria-valuenow', mm.toFixed(1));
      line.setAttribute('aria-valuetext', t('grade_line_value', [mm.toFixed(1)]));
    }
  }

  function renderMeasure(s, c) {
    const box = $('grade-measure');
    box.hidden = !c;
    if (!c) return;
    for (const axis of ['lr', 'tb']) {
      const a = c[axis];
      box.querySelector(`[data-ref="${axis}"]`).textContent = a ? ratioText(a.pct) : '–';
      box.querySelector(`[data-ref="${axis}-note"]`).textContent = a
        ? t('grade_axis_note', [t(`grade_side_${a.wide}`), a.sigma.toFixed(1)])
        : t('grade_axis_unmeasured');
    }
    const mm = (n) => (c.sides[n]?.ok ? (c.sides[n].px / s.result.borders.pxPerMm).toFixed(1) : '–');
    $('grade-borders').textContent = t('grade_borders', [mm('left'), mm('right'), mm('top'), mm('bottom')]);
  }

  function renderNotes(s) {
    const list = $('grade-notes');
    list.replaceChildren();
    const add = (key, subs = [], tone = 'info') => {
      const li = el('li'); li.dataset.tone = tone;
      li.append(icon(tone === 'warning' ? 'i-triangle' : 'i-circle-i'), el('span', '', t(key, subs)));
      list.appendChild(li);
    };
    if (s.status === 'error') { add(errorKey(s.error), [], 'warning'); return; }
    if (s.status !== 'done') return;
    const r = s.result;
    if (r.status === 'no-card') { add('grade_note_no_card', [], 'warning'); return; }
    if (r.status === 'no-border') add('grade_note_no_border', [], 'warning');
    else if (r.status === 'partial') add('grade_note_partial', [], 'warning');
    const q = r.quality;
    const sigma = centeringOf(selected)?.worst?.sigma;
    if (q.flags.includes('very-low-res')) add('grade_note_very_low_res', [q.pxPerMm.toFixed(1)], 'warning');
    else if (q.flags.includes('low-res')) add('grade_note_low_res', [q.pxPerMm.toFixed(1), sigma ? sigma.toFixed(1) : '?'], 'warning');
    for (const f of ['blurry', 'glare', 'skewed', 'cropped', 'cut-off']) if (q.flags.includes(f)) add(`grade_note_${f.replace('-', '_')}`, [], 'warning');
    if (r.source === 'manual') add('grade_note_manual');
    if (Object.keys(s.manual).length) add('grade_note_adjusted');
  }

  function drawCard(s) {
    const canvas = $('grade-card');
    if (drawn === s.card) return;
    drawn = s.card;
    if (!s.card) { canvas.width = 1; canvas.height = 1; return; }
    canvas.width = s.card.width;
    canvas.height = s.card.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(s.card.data, s.card.width, s.card.height), 0, 0);
    // Where the device saw wear: a bar along each whitened stretch of edge, an arc round each worn corner.
    const w = s.result?.wear;
    if (w?.status !== 'ok') return;
    const k = w.pxPerMm; const { width: W, height: H } = s.card;
    ctx.strokeStyle = getComputedStyle(doc.documentElement).getPropertyValue('--cs-accent').trim() || '#B3122B';
    ctx.lineWidth = Math.max(5, W / 45); // thick: it must stand out from the thin measuring lines
    const h = ctx.lineWidth / 2;
    for (const [side, e] of Object.entries(w.edges.sides)) {
      for (const r of e.runs ?? []) {
        const a = r.fromMm * k; const b = r.toMm * k;
        ctx.beginPath();
        if (side === 'top') { ctx.moveTo(a, h); ctx.lineTo(b, h); } else if (side === 'bottom') { ctx.moveTo(a, H - h); ctx.lineTo(b, H - h); } else if (side === 'left') { ctx.moveTo(h, a); ctx.lineTo(h, b); } else { ctx.moveTo(W - h, a); ctx.lineTo(W - h, b); }
        ctx.stroke();
      }
    }
    const R = CORNER_R_MM * k;
    const arcs = { tl: [R, R, Math.PI, 1.5 * Math.PI], tr: [W - R, R, 1.5 * Math.PI, 2 * Math.PI], br: [W - R, H - R, 0, 0.5 * Math.PI], bl: [R, H - R, 0.5 * Math.PI, Math.PI] };
    for (const c of WEAR_CORNERS) {
      const v = w.corners.list[c];
      if (v?.status !== 'ok' || v.rating === 'none') continue;
      const [x, y, a0, a1] = arcs[c];
      ctx.beginPath(); ctx.arc(x, y, R * 1.05, a0, a1); ctx.stroke();
    }
  }

  function renderDetail() {
    const s = sides[selected];
    const section = $('grade-detail');
    section.hidden = s.status === 'empty';
    if (section.hidden) return;
    $('grade-detail-heading').textContent = t(selected === 'front' ? 'grade_front' : 'grade_back');
    $('grade-busy').hidden = s.status !== 'loading';
    const done = s.status === 'done';
    const hasCard = done && s.card && s.result.status !== 'no-card';
    $('grade-stage').hidden = !hasCard;
    const c = hasCard ? centeringOf(selected) : null;
    if (hasCard) { drawCard(s); placeLines(s, c); }
    renderMeasure(s, c && (c.lr || c.tb) ? c : null);
    if (!(c && (c.lr || c.tb))) $('grade-borders').textContent = '';
    renderNotes(s);
    $('grade-detail-actions').hidden = !done || Boolean(corners);
    $('grade-reset').hidden = !Object.keys(s.manual).length;
    renderCorners();
  }

  function capValue(id, g) {
    if (g.centeringCap !== null) return t(id === 'bgs' ? 'grade_cap_bgs' : 'grade_cap_upto', [fmtGrade(g.centeringCap)]);
    if (g.possible !== null) return t('grade_cap_at_best', [fmtGrade(g.possible)]);
    if (g.below) return t('grade_cap_below', [fmtGrade(GRADERS[id].grades.at(-1).grade)]);
    return t('grade_cap_unknown');
  }

  function renderCaps() {
    const front = centeringOf('front');
    const back = centeringOf('back');
    const section = $('grade-caps');
    const measured = Boolean(front?.lr || front?.tb || back?.lr || back?.tb);
    section.hidden = !measured;
    if (!measured) return;
    const device = deviceRatings();
    const merged = mergeCondition(device, ai.result?.condition ?? null);
    const est = estimateGrades({ front, back, condition: merged.condition, sources: merged.sources });
    const withAi = Boolean(est.condition);
    $('grade-caps-heading').textContent = t(withAi ? 'grade_est_heading' : 'grade_caps_heading');
    const list = $('grade-caps-list');
    list.replaceChildren();
    for (const id of GRADER_ORDER) {
      const g = est.graders[id];
      const li = el('li'); li.dataset.grader = id;
      li.appendChild(el('span', 'grade-cap-name', GRADERS[id].name));
      const value = g.high !== null ? (g.low === g.high ? fmtGrade(g.high) : `${fmtGrade(g.low)}–${fmtGrade(g.high)}`) : capValue(id, g);
      li.appendChild(el('span', 'grade-cap-value', value));
      const sub = [];
      const subText = (v) => (v === null ? '?' : fmtGrade(v));
      if (g.sub) sub.push(t('grade_bgs_subs', [subText(g.sub.centering), subText(g.sub.corners), subText(g.sub.edges), subText(g.sub.surface)]));
      else if (g.high !== null) sub.push(t('grade_est_centering', [capValue(id, g)]));
      if (g.possible !== null && g.centeringCap !== null) sub.push(t('grade_cap_possible', [fmtGrade(g.possible)]));
      if (est.caps[id].limitedBy === 'back' && g.high === null) sub.push(t('grade_cap_by_back'));
      if (GRADERS[id].basis === 'guides') sub.push(t('grade_cap_guides'));
      if (sub.length) li.appendChild(el('span', 'grade-cap-sub', sub.join(' · ')));
      list.appendChild(li);
    }
    const reasons = $('grade-reasons');
    reasons.replaceChildren();
    for (const r of est.graders.psa.reasons) {
      if (r.key.startsWith('grade_reason_centering') || r.key === 'grade_reason_no_back') continue;
      // A wear rating (Claude) is shown as words in the check's own rows; only real subgrades (Ximilar) are repeated.
      if (ai.result?.ratings && /^grade_reason_(corners|edges|surface)$/.test(r.key)) continue;
      const subs = r.areas ? [r.areas.map((a) => t(`grade_area_${a}`).toLowerCase()).join(', ')] : r.subs;
      reasons.appendChild(el('li', '', t(r.key, subs)));
    }
    const notes = [];
    if (!est.caps.psa.backChecked) notes.push(t('grade_note_front_only'));
    if (!withAi) notes.push(t(device.corners === 'none' || device.edges === 'none' ? 'grade_note_device_clean' : 'grade_note_centering_only'));
    $('grade-caps-note').textContent = notes.join(' ');
  }

  // ------------------------------------------------------------ wear seen on the device

  const wearOf = (name) => (sides[name].status === 'done' ? sides[name].result?.wear ?? null : null);
  const deviceRatings = () => combineWear(PHOTO_SIDES.map(wearOf));

  /** Where the device saw wear, e.g. "top-left (back)", per area; and why it couldn't look, per area. */
  function wearDetails() {
    const where = { corners: [], edges: [] };
    const why = { corners: new Set(), edges: new Set() };
    for (const name of PHOTO_SIDES) {
      const w = wearOf(name);
      if (!w) continue;
      const photo = t(`grade_photo_${name}`);
      if (w.status !== 'ok') { why.corners.add(w.status); why.edges.add(w.status); continue; }
      for (const c of WEAR_CORNERS) {
        const v = w.corners.list[c];
        if (v?.status === 'ok' && v.rating !== 'none') where.corners.push(t('grade_where', [t(`grade_corner_${c}_short`), photo]));
        else if (v?.status === 'unknown') why.corners.add(v.reason);
        if (v?.status === 'ok' && v.whitening) why.corners.add(v.whitening);
      }
      for (const side of SIDES) {
        const e = w.edges.sides[side];
        if (e?.status === 'ok' && e.runs.length) where.edges.push(t('grade_where', [t(`grade_edge_${side}`), photo]));
        else if (e?.status === 'unknown') why.edges.add(e.reason);
      }
    }
    return { where, why };
  }

  function renderDevice(body) {
    const ratings = deviceRatings();
    const { where, why } = wearDetails();
    const ul = el('ul', 'grade-ai-rows'); ul.dataset.testid = 'grade-device';
    for (const a of ['corners', 'edges']) {
      const li = el('li'); li.dataset.area = a; li.dataset.rating = ratings[a];
      li.appendChild(el('span', 'grade-ai-area', t(`grade_area_${a}`)));
      li.appendChild(el('span', 'grade-ai-rating', t(`grade_dev_${a}_${ratings[a]}`)));
      const note = ratings[a] === 'minor' || ratings[a] === 'visible' ? where[a].join(', ')
        : [...why[a]].filter(Boolean).map((r) => t(`grade_dev_why_${r.replace('-', '_')}`)).join(' ');
      if (note) li.appendChild(el('span', 'grade-ai-note', note));
      ul.appendChild(li);
    }
    const li = el('li'); li.dataset.area = 'surface';
    li.append(el('span', 'grade-ai-area', t('grade_area_surface')), el('span', 'grade-ai-rating', t('grade_dev_surface')));
    ul.appendChild(li);
    body.appendChild(ul);
    body.appendChild(el('p', 'hint', t('grade_device_note')));
    body.appendChild(el('h4', 'grade-sub-heading', t('grade_ai_sub')));
  }

  // ------------------------------------------------------------ AI condition check

  async function aiSetup() {
    const provider = getProvider();
    const p = PROVIDERS[provider];
    if (!p) return { state: 'off' };
    const key = await loadKey(p.vendor, chromeApi);
    return key ? { state: 'ready', provider, p, key } : { state: 'no-key', provider, p };
  }

  async function renderAi() {
    const section = $('grade-ai');
    const ready = sides.front.status === 'done' && sides.front.card && sides.front.result.status !== 'no-card';
    section.hidden = !ready;
    if (!ready) return;
    const run = ++ai.run;
    const setup = ai.state === 'idle' || ai.state === 'consent' ? await aiSetup() : null;
    if (run !== ai.run) return;
    const body = $('grade-ai-body');
    body.replaceChildren();
    renderDevice(body);
    if (ai.state === 'running') {
      const p = el('p', 'small muted grade-busy');
      const spin = icon('i-spinner'); spin.classList.add('spin');
      p.append(spin, el('span', '', t('grade_ai_running', [PROVIDERS[getProvider()]?.label ?? ''])));
      body.append(p, button('link link-sm', t('cancel_button'), () => { ai.ctl?.abort(); }));
      return;
    }
    if (ai.state === 'done' && ai.result) { renderAiResult(body); return; }
    if (ai.state === 'error') {
      body.appendChild(el('p', 'field-error', t(`grade_ai_err_${ai.status.replace('-', '_')}`, [VENDORS[PROVIDERS[getProvider()]?.vendor]?.name ?? ''])));
      const row = el('div', 'actions');
      row.appendChild(button('btn btn-secondary btn-sm', t('retry_button'), () => { ai.state = 'idle'; startAi(); }));
      if (['auth', 'forbidden', 'no-permission', 'limit'].includes(ai.status)) {
        row.appendChild(button('link link-sm', t('grade_ai_open_settings'), () => openSettings('setting-grade-ai')));
      }
      body.appendChild(row);
      return;
    }
    if (setup.state === 'off') {
      body.appendChild(el('p', 'small', t('grade_ai_off')));
      body.appendChild(button('link', t('grade_ai_setup'), () => openSettings('setting-grade-ai'), 'grade-ai-setup'));
      return;
    }
    const vendor = VENDORS[setup.p.vendor];
    if (setup.state === 'no-key') {
      body.appendChild(el('p', 'small', t('grade_ai_no_key', [vendor.name])));
      body.appendChild(button('link', t('grade_ai_add_key'), () => openSettings(`setting-${setup.p.vendor}-key`)));
      return;
    }
    if (ai.state === 'consent') { renderConsent(body, setup); return; }
    const withBack = sides.back.status === 'done' && sides.back.card;
    body.appendChild(button('btn btn-strong btn-sm btn-start', t('grade_ai_check', [setup.p.label]), () => startAi(), 'grade-ai-check'));
    body.appendChild(el('p', 'hint', t(withBack ? 'grade_ai_sends_both' : 'grade_ai_sends_front', [vendor.name])));
  }

  function renderConsent(body, setup) {
    const vendor = VENDORS[setup.p.vendor];
    const box = el('div', 'grade-consent'); box.dataset.testid = 'grade-consent';
    box.appendChild(el('p', 'note-title', t('grade_consent_title', [vendor.name])));
    const ul = el('ul');
    for (const k of ['grade_consent_what', 'grade_consent_not', 'grade_consent_terms']) ul.appendChild(el('li', '', t(k, [vendor.name])));
    if (setup.p.vendor === 'ximilar') ul.appendChild(el('li', '', t('grade_consent_ximilar')));
    box.appendChild(ul);
    const row = el('div', 'actions');
    row.appendChild(button('btn btn-strong btn-sm', t('grade_consent_send'), async () => {
      await saveConsent(setup.p.vendor, chromeApi).catch(() => {});
      ai.state = 'idle';
      startAi();
    }, 'grade-consent-send'));
    row.appendChild(button('link link-sm', t('cancel_button'), () => { ai.state = 'idle'; renderAi(); }));
    box.appendChild(row);
    body.appendChild(box);
    box.querySelector('button').focus();
  }

  function renderAiResult(body) {
    const r = ai.result;
    const ul = el('ul', 'grade-ai-rows'); ul.dataset.testid = 'grade-ai-result';
    for (const a of CONDITION_AREAS) {
      const li = el('li');
      li.appendChild(el('span', 'grade-ai-area', t(`grade_area_${a}`)));
      const value = r.ratings ? t(`grade_rating_${r.ratings[a]}`) : (r.condition[a] === null ? t('grade_rating_unknown') : fmtGrade(r.condition[a]));
      li.appendChild(el('span', 'grade-ai-rating', value));
      if (r.notes?.[a]) li.appendChild(el('span', 'grade-ai-note', r.notes[a]));
      ul.appendChild(li);
    }
    body.appendChild(ul);
    if (r.photoIssues?.length) body.appendChild(el('p', 'hint', t('grade_ai_photo_issues', [r.photoIssues.join('; ')])));
    if (r.card?.name) body.appendChild(el('p', 'hint', t('grade_ai_card', [[r.card.name, r.card.number].filter(Boolean).join(' ')])));
    const foot = el('div', 'actions');
    foot.appendChild(el('span', 'hint', t('grade_ai_by', [PROVIDERS[r.provider]?.label ?? r.provider])));
    foot.appendChild(button('link link-sm', t('grade_ai_again'), () => { ai.state = 'idle'; startAi(); }));
    body.appendChild(foot);
  }

  function centeringSummary() {
    const part = (name) => {
      const c = centeringOf(name);
      if (!c?.lr && !c?.tb) return null;
      return `${name} ${[c.lr && `left/right ${ratioText(c.lr.pct)}`, c.tb && `top/bottom ${ratioText(c.tb.pct)}`].filter(Boolean).join(', ')}`;
    };
    return PHOTO_SIDES.map(part).filter(Boolean).join('; ');
  }

  async function startAi() {
    const setup = await aiSetup();
    if (setup.state !== 'ready') { ai.state = 'idle'; renderAi(); return; }
    if (!(await hasConsent(setup.p.vendor, chromeApi))) { ai.state = 'consent'; renderAi(); return; }
    ai.ctl?.abort();
    const ctl = new AbortController();
    ai.ctl = ctl;
    ai.state = 'running';
    renderAi();
    announce(t('grade_ai_running', [setup.p.label]));
    const maxSide = setup.p.vendor === 'ximilar' ? XIMILAR_IMAGE_SIDE : CLAUDE_IMAGE_SIDE;
    try {
      const front = await cardJpeg(sides.front.card, { maxSide });
      const back = sides.back.status === 'done' && sides.back.card ? await cardJpeg(sides.back.card, { maxSide }) : null;
      const res = await checkCondition({
        provider: setup.provider, key: setup.key, front, back, centering: centeringSummary(),
        language: t('locale_code').slice(0, 2), signal: ctl.signal,
      }, { chromeApi });
      if (ai.ctl !== ctl) return;
      if (res.status === 'ok') { ai.state = 'done'; ai.result = res.result; announce(t('grade_ai_done')); } else { ai.state = 'error'; ai.status = res.status; announce(t(`grade_ai_err_${res.status.replace('-', '_')}`, [VENDORS[setup.p.vendor].name])); }
    } catch {
      if (ai.ctl !== ctl) return;
      ai.state = 'idle'; // cancelled
    }
    ai.ctl = null;
    renderCaps();
    renderAi();
  }

  // ------------------------------------------------------------ hand-placed corners

  function openCorners(name) {
    const s = sides[name];
    if (!s.size) return;
    const q = s.result?.quad;
    const pts = q && s.result.status !== 'no-card'
      ? q.map(([x, y]) => [Math.max(0, Math.min(1, x / s.size.width)), Math.max(0, Math.min(1, y / s.size.height))])
      : [[0.15, 0.1], [0.85, 0.1], [0.85, 0.9], [0.15, 0.9]];
    corners = { side: name, pts };
    selected = name;
    render();
    root.querySelector('.grade-handle')?.focus();
  }

  function renderCorners() {
    const box = $('grade-corners');
    box.hidden = !corners || corners.side !== selected;
    if (box.hidden) return;
    const s = sides[corners.side];
    const img = $('grade-photo-img');
    if (img.getAttribute('src') !== s.previewUrl) img.src = s.previewUrl;
    img.alt = t('grade_photo_alt');
    const svg = $('grade-quad');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.querySelector('polygon').setAttribute('points', corners.pts.map(([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`).join(' '));
    for (const h of root.querySelectorAll('.grade-handle')) {
      const [x, y] = corners.pts[Number(h.dataset.corner)];
      h.style.left = `${x * 100}%`;
      h.style.top = `${y * 100}%`;
    }
  }

  function moveCorner(i, x, y) {
    corners.pts[i] = [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
    renderCorners();
  }

  // ------------------------------------------------------------ hand-moved border lines

  function moveLine(name, borderPx) {
    const s = sides[selected];
    const { card } = s;
    const max = (name === 'left' || name === 'right' ? card.width : card.height) * 0.4;
    s.manual[name] = Math.max(1, Math.min(max, borderPx));
    renderDetail();
  }

  function borderFromPointer(name, e) {
    const s = sides[selected];
    const rect = $('grade-stage').getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const { width: W, height: H } = s.card;
    if (name === 'left') return fx * W;
    if (name === 'right') return (1 - fx) * W;
    if (name === 'top') return fy * H;
    return (1 - fy) * H;
  }

  function render() {
    renderSlots();
    renderDetail();
    renderCaps();
    renderAi();
  }

  // ------------------------------------------------------------ events

  root.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-action]');
    if (!b) return;
    const a = b.dataset.action;
    const side = b.dataset.side;
    if (a === 'grade-select') {
      if (sides[side].status === 'empty') { pendingSide = side; fileInput.click(); return; }
      selected = side; render();
    } else if (a === 'grade-choose') { pendingSide = side; fileInput.click(); }
    else if (a === 'grade-remove') remove(side);
    else if (a === 'grade-swap') swap();
    else if (a === 'grade-corners') openCorners(selected);
    else if (a === 'grade-corners-cancel') { corners = null; render(); }
    else if (a === 'grade-measure' && corners) {
      const s = sides[corners.side];
      const quad = corners.pts.map(([x, y]) => [x * s.size.width, y * s.size.height]);
      measure(corners.side, { quad });
    } else if (a === 'grade-reset') { sides[selected].manual = {}; render(); }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0] ?? null;
    fileInput.value = '';
    if (file) addFile(file, 'upload', pendingSide);
    pendingSide = null;
  });

  for (const line of root.querySelectorAll('.grade-line')) {
    const name = line.dataset.line;
    line.addEventListener('pointerdown', (e) => {
      if (!sides[selected].card) return;
      e.preventDefault();
      line.setPointerCapture(e.pointerId);
      line.focus();
      const onMove = (ev) => moveLine(name, borderFromPointer(name, ev));
      const onUp = () => { line.removeEventListener('pointermove', onMove); line.removeEventListener('pointerup', onUp); line.removeEventListener('pointercancel', onUp); render(); };
      line.addEventListener('pointermove', onMove);
      line.addEventListener('pointerup', onUp);
      line.addEventListener('pointercancel', onUp);
    });
    line.addEventListener('keydown', (e) => {
      const s = sides[selected];
      const cur = centeringOf(selected)?.sides?.[name];
      if (!s.card || !cur?.ok) return;
      const vertical = name === 'left' || name === 'right';
      const dir = { ArrowLeft: vertical ? -1 : 0, ArrowRight: vertical ? 1 : 0, ArrowUp: vertical ? 0 : -1, ArrowDown: vertical ? 0 : 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const rect = $('grade-stage').getBoundingClientRect();
      const step = ((vertical ? s.card.width / rect.width : s.card.height / rect.height) || 1) * (e.shiftKey ? 5 : 1);
      // The arrow moves the line; the left/top border grows when its line moves right/down, the others shrink.
      const grows = name === 'left' || name === 'top' ? dir : -dir;
      moveLine(name, cur.px + grows * step);
      renderSlots(); renderCaps();
    });
  }

  for (const h of root.querySelectorAll('.grade-handle')) {
    const i = Number(h.dataset.corner);
    h.addEventListener('pointerdown', (e) => {
      if (!corners) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      h.focus();
      const onMove = (ev) => { const r = $('grade-photo').getBoundingClientRect(); moveCorner(i, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height); };
      const onUp = () => { h.removeEventListener('pointermove', onMove); h.removeEventListener('pointerup', onUp); h.removeEventListener('pointercancel', onUp); };
      h.addEventListener('pointermove', onMove);
      h.addEventListener('pointerup', onUp);
      h.addEventListener('pointercancel', onUp);
    });
    h.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d || !corners) return;
      e.preventDefault();
      const r = $('grade-photo').getBoundingClientRect();
      const k = e.shiftKey ? 10 : 1;
      const [x, y] = corners.pts[i];
      moveCorner(i, x + (d[0] * k) / (r.width || 300), y + (d[1] * k) / (r.height || 400));
    });
  }

  const isFileDrag = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  root.addEventListener('dragover', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; doc.body.classList.add('is-grade-drag'); });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) doc.body.classList.remove('is-grade-drag'); });
  root.addEventListener('drop', (e) => {
    doc.body.classList.remove('is-grade-drag');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    addFile(file, 'drop', e.target.closest?.('.grade-slot')?.dataset.side ?? null);
  });
  doc.addEventListener('paste', (e) => {
    if (root.hidden) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file');
    if (!item) return;
    e.preventDefault();
    addFile(item.getAsFile(), 'paste');
  });

  // Static texts with links (sources of the limits).
  function renderSources() {
    const p = $('grade-sources');
    p.replaceChildren(el('span', '', t('grade_sources', [STANDARDS_AS_OF])));
    for (const id of GRADER_ORDER) {
      const g = GRADERS[id];
      const b = button('link', g.name, () => openTab(g.url));
      b.appendChild(icon('i-external'));
      const sr = el('span', 'visually-hidden', t('a11y_new_tab'));
      b.appendChild(sr);
      p.appendChild(b);
    }
    $('grade-input-hint').textContent = t('grade_input_hint');
  }
  renderSources();
  render();

  return {
    /** Called when the view is shown. */
    onShow() { render(); $('grade-title').focus(); },
    addInput,
    /** Settings changed (provider or key): the AI section shows the new state. */
    refreshAi() { if (ai.state !== 'running') { ai.state = ai.result ? 'done' : 'idle'; } renderAi(); },
    /** Escape: close the corner editor first. Returns true when it handled the key. */
    escape() { if (corners) { corners = null; render(); return true; } return false; },
    dispose() { for (const n of PHOTO_SIDES) sides[n].ctl?.abort(); ai.ctl?.abort(); engine.dispose(); },
  };
}
