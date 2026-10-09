// Injected with chrome.scripting.executeScript({func: pageProbe}) into the clicked frame, ISOLATED world.
// Chrome serializes func.toString(): this function MUST be self-contained (no imports, no closure
// variables, no helpers outside its body). It leaves no listeners or globals behind.
// Its return value is UNTRUSTED until validateProbeResult() passes (src/pipeline/probeValidate.js).

/**
 * @param {string} srcUrl the clicked image URL (info.srcUrl)
 * @param {'inspect'|'capture'} mode inspect = locate + page-context fetch; capture = locate, scroll into view, measure
 * @param {number} maxBytes fetch cap
 */
export async function pageProbe(srcUrl, mode, maxBytes) {
  const FETCH_TIMEOUT_MS = 8000;
  const out = { v: 1, found: false };

  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return null; } };
  const sameOrigin = (a, b) => {
    try {
      const oa = new URL(a); const ob = new URL(b);
      const o = (u) => (u.protocol === 'blob:' ? new URL(u.pathname).origin : u.origin);
      return o(oa) === o(ob);
    } catch { return false; }
  };

  // 1. Locate the <img>.
  let img = null;
  for (const el of document.images) {
    if (el.currentSrc === srcUrl || el.src === srcUrl || abs(el.getAttribute('src') || '') === srcUrl) { img = el; break; }
  }
  if (!img) return out;
  out.found = true;

  // 2. Geometry in top-level viewport coordinates (only reachable through same-origin parents).
  const measure = () => {
    const r = img.getBoundingClientRect();
    let x = r.left; let y = r.top; let topLevel = true;
    let w = window; let topWin = window;
    try {
      while (w !== w.top) {
        const fe = w.frameElement;
        if (!fe) { topLevel = false; break; }
        const fr = fe.getBoundingClientRect();
        x += fr.left + fe.clientLeft;
        y += fr.top + fe.clientTop;
        w = w.parent;
      }
      topWin = w;
    } catch { topLevel = false; }
    let vw = window.innerWidth; let vh = window.innerHeight;
    if (topLevel) { try { vw = topWin.innerWidth; vh = topWin.innerHeight; } catch { topLevel = false; } }
    return { rect: { x, y, width: r.width, height: r.height }, rectIsTopLevel: topLevel, viewport: { width: vw, height: vh } };
  };
  const visibleFraction = (m) => {
    const { x, y, width, height } = m.rect;
    const ix = Math.max(0, Math.min(x + width, m.viewport.width) - Math.max(x, 0));
    const iy = Math.max(0, Math.min(y + height, m.viewport.height) - Math.max(y, 0));
    return width > 0 && height > 0 ? (ix * iy) / (width * height) : 0;
  };

  // rAF is paused in hidden/background pages: never wait more than ~300 ms (SEC-03).
  const twoFrames = () => new Promise((r) => {
    let done = false;
    const finish = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 300);
  });
  let m = measure();
  if (mode === 'capture' && visibleFraction(m) < 0.98) {
    img.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await twoFrames();
    m = measure();
  }
  if (mode === 'capture' && !(img.complete && img.naturalWidth > 0)) {
    // e.g. loading="lazy" images that only start loading once scrolled near the viewport
    await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    await twoFrames();
    m = measure();
  }
  Object.assign(out, m);
  out.dpr = window.devicePixelRatio || 1;
  out.natural = { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };

  // 3. Largest 'w' srcset candidate, same origin as srcUrl only.
  out.srcsetBest = null;
  try {
    const sets = [img.getAttribute('srcset') || ''];
    if (img.parentElement && img.parentElement.tagName === 'PICTURE') {
      for (const s of img.parentElement.querySelectorAll('source')) sets.push(s.getAttribute('srcset') || '');
    }
    let best = 0;
    for (const set of sets) {
      for (const part of set.split(/,\s+/)) {
        const [u, d] = part.trim().split(/\s+/);
        const wm = /^(\d+)w$/.exec(d || '');
        const url = u ? abs(u) : null;
        if (wm && url && /^https?:/.test(url) && Number(wm[1]) > best && sameOrigin(url, srcUrl)) {
          best = Number(wm[1]);
          out.srcsetBest = url;
        }
      }
    }
  } catch { out.srcsetBest = null; }

  if (mode !== 'inspect') return out;

  // 4. Page-context fetch (page CORS rules) of srcsetBest, then srcUrl; returned as a data URL.
  const fetchOne = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { cache: 'force-cache', signal: ctrl.signal });
      if (!res.ok) return { ok: false, reason: 'http' };
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) return { ok: false, reason: 'too-large' };
      const reader = res.body.getReader();
      const chunks = []; let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { ctrl.abort(); return { ok: false, reason: 'too-large' }; }
        chunks.push(value);
      }
      const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      const blob = new Blob(chunks, { type: /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream' });
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
      return { ok: true, dataUrl, url };
    } catch (e) {
      return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'cors' };
    } finally {
      clearTimeout(timer);
    }
  };

  let result = { ok: false, reason: 'cors' };
  for (const url of [out.srcsetBest, srcUrl]) {
    if (!url) continue;
    result = await fetchOne(url);
    if (result.ok) break;
  }
  out.fetch = result;
  return out;
}
