// A9 page discovery. Injected with chrome.scripting.executeScript({func: pageImagesProbe}) into the MAIN FRAME,
// ISOLATED world. Chrome serializes func.toString(): this function MUST be self-contained (no imports, no closure
// variables). It reads image URLs and geometry only (no page text, no DOM content) and leaves nothing behind.
// The return value is UNTRUSTED until validatePageImages() (src/pipeline/probeValidate.js) passes.

/**
 * @param {{minRendered?:number, minNatural?:number, max?:number}} opts
 * @returns {Promise<{v:1, viewport:{width:number,height:number}, dpr:number, images:object[]}>}
 */
export async function pageImagesProbe(opts) {
  const minRendered = (opts && opts.minRendered) || 120;
  const minNatural = (opts && opts.minNatural) || 150;
  const max = (opts && opts.max) || 24;
  const MAX_SRC = 2000000;
  let dataBudget = 8000000; // total chars of data: URLs returned (IPC size guard)
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return null; } };
  const originOf = (u) => {
    try { const x = new URL(u); return x.protocol === 'blob:' ? new URL(x.pathname).origin : x.origin; } catch { return null; }
  };

  const seen = new Set();
  const out = [];
  for (const img of document.images) {
    const srcUrl = img.currentSrc || img.src;
    if (!srcUrl || seen.has(srcUrl) || srcUrl.length > MAX_SRC) continue;
    if (!/^(https?|data|blob):/i.test(srcUrl)) continue;
    if (/^data:image\/svg|\.svgz?(?:[?#]|$)/i.test(srcUrl)) continue;
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue; // not loaded (e.g. lazy below the fold)
    if (Math.min(img.naturalWidth, img.naturalHeight) < minNatural) continue;
    const r = img.getBoundingClientRect();
    if (Math.min(r.width, r.height) < minRendered) continue;
    if (/^data:/i.test(srcUrl)) {
      if (srcUrl.length > dataBudget) continue;
      dataBudget -= srcUrl.length;
    }
    const ix = Math.max(0, Math.min(r.left + r.width, vw) - Math.max(r.left, 0));
    const iy = Math.max(0, Math.min(r.top + r.height, vh) - Math.max(r.top, 0));
    const visibleFraction = r.width > 0 && r.height > 0 ? Math.min(1, (ix * iy) / (r.width * r.height)) : 0;

    let srcsetBest = null;
    try {
      const sets = [img.getAttribute('srcset') || ''];
      const parent = img.parentElement;
      if (parent && parent.tagName === 'PICTURE' && parent.querySelectorAll) {
        for (const s of parent.querySelectorAll('source')) sets.push(s.getAttribute('srcset') || '');
      }
      let best = 0;
      for (const set of sets) {
        for (const part of set.split(/,\s+/)) {
          const bits = part.trim().split(/\s+/);
          const m = /^(\d+)w$/.exec(bits[1] || '');
          const u = bits[0] ? abs(bits[0]) : null;
          if (m && u && /^https?:/.test(u) && Number(m[1]) > best && originOf(u) === originOf(srcUrl)) {
            best = Number(m[1]);
            srcsetBest = u;
          }
        }
      }
    } catch { srcsetBest = null; }

    seen.add(srcUrl);
    out.push({
      srcUrl,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      natural: { width: img.naturalWidth, height: img.naturalHeight },
      srcsetBest,
      visibleFraction,
    });
  }
  const visibleArea = (i) => i.rect.width * i.rect.height * i.visibleFraction;
  out.sort((a, b) => (visibleArea(b) - visibleArea(a)) || (b.rect.width * b.rect.height - a.rect.width * a.rect.height));
  return { v: 1, viewport: { width: vw, height: vh }, dpr: window.devicePixelRatio || 1, images: out.slice(0, max) };
}
