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
 */
export function createCertField({ input, fieldset, errorEl, previewEl, hintEl, radioName, prefill = null, cgcHint = true }) {
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

  function refresh({ immediateWarn = false } = {}) {
    const c = current();
    const { a, r } = c;
    setChecked(r.grader);
    hintEl.textContent = r.from === 'inferred' ? t('grader_auto_hint') : (r.cgcBoth && cgcHint ? t('reason_cgc_both') : '');
    const digits = a.url?.ok ? a.url.number : a.digits;
    const p = previewText(r.grader, digits);
    previewEl.textContent = p ? t(p.key, p.subs) : '';
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
