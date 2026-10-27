// Printable test cards page: localized texts and the Print button (no inline script under the extension's CSP).
import { applyI18n } from '../shared/i18n.js';

applyI18n(document);
document.getElementById('tc-print').addEventListener('click', () => window.print());
