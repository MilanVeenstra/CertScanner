// i18n helpers (ADR-001 §12): t(key, subs) and applyI18n(root) for [data-i18n] elements.
// textContent/attributes only; never HTML.

/** Localized message, or the key itself when missing (makes gaps visible instead of blank). */
export function t(key, subs) {
  const msg = globalThis.chrome?.i18n?.getMessage(key, subs);
  return msg || key;
}

/**
 * - data-i18n="key"                 -> textContent
 * - data-i18n-attr="attr:key;attr2:key2" -> attributes (aria-label, placeholder, title, alt)
 * Also sets <html lang> from the 'locale_code' message and dir from @@bidi_dir.
 */
const ALLOWED_ATTRS = new Set(['aria-label', 'placeholder', 'title', 'alt', 'aria-description']);

export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key && ALLOWED_ATTRS.has(attr)) el.setAttribute(attr, t(key));
    }
  }
  if (root.documentElement) {
    const lang = t('locale_code');
    if (/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) root.documentElement.lang = lang;
    const dir = t('@@bidi_dir');
    if (dir === 'ltr' || dir === 'rtl') root.documentElement.dir = dir;
  }
}
