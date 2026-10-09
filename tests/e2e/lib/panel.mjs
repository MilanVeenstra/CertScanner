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

/** Toggle a settings checkbox. Uses a real click when the control is visible, else el.click() (settings sub-view). */
export async function setSetting(page, key, value) {
  const sel = tid(`setting-${key}`);
  const current = await page.locator(sel).isChecked();
  if (current === value) return;
  if (await isVisible(page, `setting-${key}`)) await page.locator(sel).click();
  else await page.locator(sel).evaluate((el) => el.click());
  // Turning history off may ask for confirmation; that flow is tested separately.
  await poll(async () => (await page.locator(sel).isChecked()) === value || key === 'saveHistory', { message: `setting ${key}` });
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

export { sleep };
