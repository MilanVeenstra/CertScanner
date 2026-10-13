// Cert number field + grader segmented control (UX spec §4). Used by the manual form, S3 confirm and S2e edit.
// DOM only through textContent/attributes; parsing and validation live in viewModel.js (pure).
import { t } from '../shared/i18n.js';
import { isValidCert } from '../core/certUrls.js';
import { analyzeCertInput, resolveGrader, validateCert, stripPrefix, previewText, MIN_DIGITS, MAX_DIGITS, GRADER_NAME } from './viewModel.js';

const WARN_DELAY_MS = 600;

/**
 * @param {{input:HTMLInputElement, fieldset:HTMLFieldSetElement, errorEl:HTMLElement, previewEl:HTMLElement,
 *   hintEl:HTMLElement, radioName:string, prefill?:{number:string, grader:string|null}, cgcHint?:boolean}} els
 *   cgcHint=false when the task card already shows reason_cgc_both (no duplicate text).
 *   autoHide=true: the grader buttons stay hidden while the grader follows from what was typed (prefix, length, "00…"),
 *   and only appear when the number fits several graders.
 */
export function createCertField({ input, fieldset, errorEl, previewEl, hintEl, radioName, prefill = null, cgcHint = true, autoHide = false }) {
  const radios = [...fieldset.querySelectorAll('input[type="radio"]')];
  for (const r of radios) r.name = radioName;
  let explicit = prefill?.grader ?? null;
  let submitted = false;
  let warnTimer = null;
  const initialNumber = prefill?.number ?? '';

  function setChecked(grader) {
    for (const r of radios) r.checked = r.value === grader;
    fieldset.dataset.value = grader ?? '';
  }

  function showError(key, subs = [], { warning = false } = {}) {
    errorEl.textContent = key ? t(key, subs) : '';
    errorEl.classList.toggle('is-warning', Boolean(key) && warning);
    if (key && !warning) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }

  function current() {
    const a = analyzeCertInput(input.value);
    return { a, r: resolveGrader(a, explicit) };
  }

  function lengthWarning({ a, r }) {
    const digits = a.url?.ok ? a.url.number : a.digits;
    if (!r.grader || !digits || digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
    return isValidCert(r.grader, digits) ? null : [GRADER_NAME[r.grader]];
  }

  function syncVisibility({ a, r }) {
    if (!autoHide) return;
    const digits = a.url?.ok ? a.url.number : a.digits;
    fieldset.hidden = !(explicit || (!r.grader && (submitted || digits.length >= MIN_DIGITS)));
  }

  function refresh({ immediateWarn = false } = {}) {
    const c = current();
    const { a, r } = c;
    setChecked(r.grader);
    syncVisibility(c);
    hintEl.textContent = r.from === 'inferred' ? t('grader_auto_hint') : (r.cgcBoth && cgcHint ? t('reason_cgc_both') : '');
    const digits = a.url?.ok ? a.url.number : a.digits;
    const p = previewText(r.grader, digits);
    // Grader buttons still hidden: the grader comes from the number, so don't ask the user to choose one (D7).
    const key = p?.key === 'url_preview_pending' && fieldset.hidden ? 'url_preview_auto' : p?.key;
    previewEl.textContent = p ? t(key, p.subs) : '';
    // Design v2: the address in "Opens <url>" is set in the mono face.
    const url = key === 'url_preview' ? p.subs[0] : null;
    const at = url ? previewEl.textContent.indexOf(url) : -1;
    if (at >= 0) {
      const text = previewEl.textContent;
      const mono = previewEl.ownerDocument.createElement('span');
      mono.className = 'mono';
      mono.textContent = url;
      previewEl.textContent = '';
      previewEl.append(text.slice(0, at), mono, text.slice(at + url.length));
    }
    clearTimeout(warnTimer);
    if (submitted) {
      const v = validateCert(input.value, explicit);
      if (v.ok) showError(null);
      else showError(v.error, v.subs);
      return;
    }
    const warn = lengthWarning(c);
    if (!warn) { if (errorEl.classList.contains('is-warning')) showError(null); return; }
    const show = () => showError('warn_length', warn, { warning: true });
    if (immediateWarn) show(); else warnTimer = setTimeout(show, WARN_DELAY_MS);
  }

  const onInput = () => {
    if (!input.value.trim()) explicit = null; // inference resumes once the field was emptied
    refresh();
  };
  const onChange = (e) => {
    if (e.target.type !== 'radio') return;
    explicit = e.target.value;
    const a = analyzeCertInput(input.value);
    const conflict = a.prefix && a.prefix !== explicit && !(a.prefix === 'cgc' && explicit.startsWith('cgc-'));
    if (conflict) input.value = stripPrefix(input.value); // what is shown is always what will be used
    refresh({ immediateWarn: true });
  };
  input.addEventListener('input', onInput);
  fieldset.addEventListener('change', onChange);

  if (prefill) input.value = prefill.number ?? '';
  refresh({ immediateWarn: true });

  return {
    /** Validate for submit; shows the error and moves focus on failure. */
    submit() {
      submitted = true;
      syncVisibility(current());
      const v = validateCert(input.value, explicit);
      if (!v.ok) {
        showError(v.error, v.subs);
        if (v.focus === 'grader') radios[0]?.focus(); else input.focus();
        return null;
      }
      showError(null);
      return { grader: v.grader, number: v.number, edited: v.number !== initialNumber };
    },
    /** Fill from a candidate: the grader is set only when known with confidence. */
    fill(number, grader) {
      input.value = number;
      if (grader) explicit = grader;
      submitted = false;
      showError(null);
      refresh({ immediateWarn: true });
    },
    reset() {
      input.value = '';
      explicit = null;
      submitted = false;
      showError(null);
      refresh();
    },
    selection() {
      const { a, r } = current();
      return { grader: r.grader, number: a.url?.ok ? a.url.number : a.digits };
    },
    destroy() {
      clearTimeout(warnTimer);
      input.removeEventListener('input', onInput);
      fieldset.removeEventListener('change', onChange);
    },
  };
}
