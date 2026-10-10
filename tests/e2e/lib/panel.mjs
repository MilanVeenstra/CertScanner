// Side-panel interactions through the ADR §13 test ids only (no visible text, no CSS classes).
import { logMark, poll, sleep, waitForScanEnd } from './env.mjs';

export const tid = (id) => `[data-testid="${id}"]`;

/** Pick a grader in the confirm form: <select data-testid=grader-select> or a radio group with that test id. */
export async function chooseGrader(page, grader) {
  const loc = page.locator(tid('grader-select'));
  const isSelect = await loc.evaluate((el) => el instanceof HTMLSelectElement);
  if (isSelect) {
    await loc.selectOption(grader);
  } else {
    await loc.locator(`input[type=radio][value="${grader}"]`).check();
  }
}

/** Press Tab until the element with `testId` has focus (keyboard-only navigation). */
export async function tabTo(page, testId, { max = 120 } = {}) {
  for (let i = 0; i < max; i++) {
    const at = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
    if (at === testId) return i;
    await page.keyboard.press('Tab');
  }
  throw new Error(`could not reach ${testId} with Tab`);
}

/** Visible-and-enabled check for a test id (hidden ancestors count as hidden). */
export async function isVisible(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0;
  }, testId);
}

/**
 * Settings switches. `data-inverted="true"` marks a switch whose checked state is the opposite of the
 * setting (the UX shows autoOpen as "Always ask before opening", ADR D5).
 */
export async function getSetting(page, key) {
  return page.locator(tid(`setting-${key}`)).evaluate((el) => (el.dataset.inverted === 'true' ? !el.checked : el.checked));
}

/** Change a setting through its switch (real click when visible, el.click() inside the hidden Settings view). */
export async function setSetting(page, key, value) {
  if ((await getSetting(page, key)) === value) return;
  if (await isVisible(page, `setting-${key}`)) await page.locator(tid(`setting-${key}`)).click();
  else await page.locator(tid(`setting-${key}`)).evaluate((el) => el.click());
  await poll(async () => (await getSetting(page, key)) === value, { message: `setting ${key}` });
}

/** Read chrome.storage from the panel realm (independent of the service worker's lifetime). */
export async function storageGet(page, area, key) {
  return page.evaluate(async ({ area, key }) => (await chrome.storage[area].get(key))[key] ?? null, { area, key });
}

/** Fire a synthetic paste of an image file at the panel document. */
export async function pasteImage(page, buf, type = 'image/png') {
  const mark = await logMark(page);
  await page.evaluate(({ b64, type }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { b64: buf.toString('base64'), type });
  return waitForScanEnd(page, mark);
}

/** Fire a synthetic drag-and-drop of an image file onto the upload control (bubbles to its drop zone). */
export async function dropImage(page, buf, type = 'image/png') {
  const mark = await logMark(page);
  await page.evaluate(({ b64, type }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type }));
    const target = document.querySelector('[data-testid="upload-input"]');
    for (const t of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { b64: buf.toString('base64'), type });
  return waitForScanEnd(page, mark);
}

/** Accessible name of the element with a test id (label, aria-label, aria-labelledby, text). */
export async function accessibleNames(page, ids) {
  return page.evaluate((list) => {
    const name = (el) => {
      if (!el) return null;
      const lb = el.getAttribute('aria-labelledby');
      if (lb) return lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? '').join(' ').trim();
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      if (el.labels?.length) return [...el.labels].map((l) => l.textContent).join(' ').trim();
      if (el.title) return el.title.trim();
      return (el.textContent ?? '').trim();
    };
    return Object.fromEntries(list.map((id) => [id, name(document.querySelector(`[data-testid="${id}"]`))]));
  }, ids);
}

/**
 * A9 page-scan view: body/task state, heading, the results rows (`page-result-<i>` with data-number/data-grader),
 * the progress line, tips and the live status. Row buttons are found by `data-ref` (open / choose / copy).
 */
export async function readPage(page) {
  return page.evaluate(() => {
    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    const visible = (el) => !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0;
    const rows = [...document.querySelectorAll('[data-testid]')].filter((el) => /^page-result-\d+$/.test(el.dataset.testid)).map((li) => {
      const ref = (r) => li.querySelector(`[data-ref="${r}"]`);
      const thumb = ref('thumb');
      return {
        i: Number(li.dataset.testid.slice('page-result-'.length)),
        number: li.dataset.number ?? null,
        grader: li.dataset.grader || null,
        opened: li.dataset.opened === 'true',
        path: visible(ref('path')) ? ref('path').textContent.trim() : '',
        thumb: visible(ref('thumb-box')) && !!thumb?.getAttribute('src'),
        thumbAlt: thumb?.alt ?? '',
        note: visible(ref('note')) ? ref('note').textContent.trim() : '',
        noteTone: ref('note')?.dataset.tone ?? null,
        open: visible(ref('open')),
        choose: visible(ref('choose')),
        copy: visible(ref('copy')),
        openName: ref('open')?.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent.trim() ?? '').join(' ') ?? '',
      };
    });
    const task = document.getElementById('task');
    const err = q('error-message');
    return {
      body: document.body.dataset.state,
      task: task?.dataset.state ?? null,
      heading: document.getElementById('task-heading')?.textContent.trim() ?? '',
      listVisible: visible(q('page-result-list')),
      rows,
      summary: [...(task?.querySelectorAll('[data-ref="summary"] p') ?? [])].map((p) => p.textContent.trim()),
      progress: q('page-progress')?.textContent.trim() ?? '',
      progressVisible: visible(q('page-progress')),
      tips: [...(task?.querySelectorAll('.tips li') ?? [])].map((li) => li.textContent.trim()),
      noneReason: task?.querySelector('[data-ref="none-reason"]')?.textContent.trim() ?? '',
      accessBody: task?.querySelector('[data-ref="access-body"]')?.textContent.trim() ?? '',
      alwaysAllowVisible: visible(q('always-allow-button')),
      actions: [...(task?.querySelectorAll('[data-action]') ?? [])].filter(visible).map((b) => b.dataset.action),
      pageScanButtonVisible: visible(q('page-scan-button')),
      error: visible(err) ? err.textContent.trim() : '',
      errorCode: err?.dataset.code ?? '',
      status: q('status-live')?.textContent.trim() ?? '',
      focusId: document.activeElement?.id ?? null,
      lang: document.documentElement.lang,
    };
  });
}

/**
 * Replace chrome.permissions.contains/request in the panel realm only. The e2e build holds <all_urls>
 * and headless Chromium cannot show the permission prompt; this stub lets the real UI, acquisition,
 * capture, OCR and tab opening run while "not granted until the user accepts" is simulated.
 */
export async function stubPermissions(page, { grant }) {
  return page.evaluate((grantOnRequest) => {
    const perms = chrome.permissions;
    let granted = false;
    window.__perm = { requests: 0, origins: [] };
    const contains = async () => granted;
    const request = async (p) => { window.__perm.requests++; window.__perm.origins.push(p?.origins ?? []); granted = grantOnRequest; return grantOnRequest; };
    try { perms.contains = contains; perms.request = request; } catch { /* try defineProperty */ }
    if (perms.contains !== contains) {
      try {
        Object.defineProperty(perms, 'contains', { value: contains, configurable: true, writable: true });
        Object.defineProperty(perms, 'request', { value: request, configurable: true, writable: true });
      } catch { return false; }
    }
    return chrome.permissions.contains === contains && chrome.permissions.request === request;
  }, grant);
}

export { sleep };
