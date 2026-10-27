// Settings > Grade check: which AI check (off by default) and the user's own key for it. Saving a key asks for that
// API's host access (the first call in the click handler, a user gesture); removing it gives the access back and
// forgets the consent.
import { PROVIDERS, VENDORS, loadKey, saveKey, clearKey, testKey } from './gradeAi.js';

/**
 * @param {{doc:Document, t:(k:string, s?:string[])=>string, getSettings:()=>object, saveSettings:(p:object)=>Promise<object>,
 *   onChange:()=>void, openTab:(url:string)=>void, chromeApi?:typeof chrome}} o
 * @returns {{render:(settings:object)=>Promise<void>}}
 */
export function wireGradeSettings({ doc, t, getSettings, saveSettings, onChange, openTab, chromeApi = globalThis.chrome }) {
  const $ = (id) => doc.getElementById(id);
  const select = $('setting-grade-ai');

  function status(vendor, key = null) {
    const s = $(`${vendor}-key-status`);
    s.textContent = key ? t(key, [VENDORS[vendor].name]) : '';
    s.parentElement.querySelector('.key-ok')?.toggleAttribute('hidden', !(key && /_(works|saved)$/.test(key)));
  }

  async function render(settings = getSettings(), { keepStatus = false } = {}) {
    const provider = PROVIDERS[settings.gradeAi] ? settings.gradeAi : 'off';
    select.value = provider;
    const vendor = PROVIDERS[provider]?.vendor ?? null;
    $('hint-grade-ai').textContent = t(vendor ? `setting_grade_ai_hint_${provider.replace('-', '_')}` : 'setting_grade_ai_hint_off');
    for (const v of Object.keys(VENDORS)) {
      const row = $(`grade-key-row-${v}`);
      row.hidden = v !== vendor;
      const key = await loadKey(v, chromeApi);
      $(`${v}-key-remove`).hidden = !key;
      if (!keepStatus) status(v, key ? 'setting_ai_key_saved' : null);
    }
  }

  select.addEventListener('change', async () => {
    try { await saveSettings({ gradeAi: select.value }); } catch { /* reverted below */ }
    await render();
    onChange();
  });

  for (const vendor of Object.keys(VENDORS)) {
    const v = VENDORS[vendor];
    const input = $(`setting-${vendor}-key`);
    $(`${vendor}-key-save`).addEventListener('click', () => {
      const key = input.value.trim();
      if (!v.isKey(key)) { status(vendor, 'setting_ai_key_invalid'); return; }
      chromeApi.permissions.request({ origins: [v.permission] }).then(async (granted) => {
        if (!granted) { status(vendor, 'setting_ai_key_denied'); return; }
        status(vendor, 'setting_key_checking');
        const check = await testKey(vendor, key, { chromeApi });
        if (check === 'auth') { status(vendor, 'setting_ai_key_rejected'); return; } // not saved
        try { await saveKey(vendor, key, chromeApi); } catch { status(vendor, 'setting_key_not_saved'); return; }
        input.value = '';
        await render(getSettings(), { keepStatus: true });
        status(vendor, { ok: 'setting_ai_key_works', limit: 'setting_ai_key_saved_limit' }[check] ?? 'setting_ai_key_saved');
        onChange();
      }, () => status(vendor, 'setting_ai_key_denied'));
    });
    $(`${vendor}-key-remove`).addEventListener('click', async () => {
      await clearKey(vendor, chromeApi).catch(() => {});
      chromeApi.permissions.remove({ origins: [v.permission] }).catch(() => {}); // the key was the only reason for it
      await render(getSettings(), { keepStatus: true });
      status(vendor, 'setting_ai_key_removed');
      onChange();
    });
    $(`${vendor}-key-get`).addEventListener('click', () => openTab(v.signup));
  }

  return { render };
}
