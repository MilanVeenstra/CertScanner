// A9 page discovery. Injected with chrome.scripting.executeScript({func: pageImagesProbe}) into the MAIN FRAME,
// ISOLATED world. Chrome serializes func.toString(): this function MUST be self-contained (no imports, no closure
// variables). It reads image URLs and geometry only (no page text, no DOM content) and leaves nothing behind.
// The return value is UNTRUSTED until validatePageImages() (src/pipeline/probeValidate.js) passes.

/**
 * SEC-13: images hidden with CSS (display/visibility/content-visibility, opacity 0) are skipped. For each image the
 * probe reports `topmostAtCenter`: at the centre of the image's visible part the image itself is what the user sees
 * (hit test: the image is the first element there, or an ancestor when the image has `pointer-events:none`) and its
 * effective opacity is at least 0.5. Page routing auto-opens only for prominent images (see core/pageAggregate.js).
 * `total` counts every qualifying image before the cap (O10).
 * @param {{minRendered?:number, minNatural?:number, max?:number}} opts
 * @returns {Promise<{v:1, viewport:{width:number,height:number}, dpr:number, images:object[], total:number}>}
 */
export async function pageImagesProbe(opts) {
  const minRendered = (opts && opts.minRendered) || 120;
  const minNatural = (opts && opts.minNatural) || 150;
  const max = (opts && opts.max) || 24;
  const MAX_SRC = 2000000;
  const MAX_ANCESTORS = 64;
  let dataBudget = 8000000; // total chars of data: URLs returned (IPC size guard)
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return null; } };
  const originOf = (u) => {
    try { const x = new URL(u); return x.protocol === 'blob:' ? new URL(x.pathname).origin : x.origin; } catch { return null; }
  };
  const styleOf = (el) => { try { return window.getComputedStyle(el); } catch { return null; } };
  /** CSS-hidden (display:none, visibility:hidden, content-visibility, opacity:0 anywhere up the tree)? */
  const cssVisible = (img) => {
    if (typeof img.checkVisibility !== 'function') return true; // feature-detect (Chrome 105+)
    try {
      return img.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
    } catch { return true; }
  };
  /** Product of the computed opacity of the image and its ancestors (bounded walk). */
  const effectiveOpacity = (img) => {
    let o = 1;
    let el = img;
    for (let k = 0; el && k < MAX_ANCESTORS; k++, el = el.parentElement) {
      const s = styleOf(el);
      const v = s ? Number.parseFloat(s.opacity) : 1;
      if (Number.isFinite(v)) o *= Math.min(1, Math.max(0, v));
    }
    return o;
  };
  /** Is the image what the user sees at the centre of its visible part? */
  const topmostAt = (img, r) => {
    const x0 = Math.max(r.left, 0);
    const y0 = Math.max(r.top, 0);
    const x1 = Math.min(r.left + r.width, vw);
    const y1 = Math.min(r.top + r.height, vh);
    if (!(x1 > x0 && y1 > y0)) return false;
    let first = null;
    try {
      const hits = document.elementsFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
      first = hits && hits.length ? hits[0] : null;
    } catch { return false; }
    if (!first) return false;
    let hit = first === img;
    if (!hit && typeof first.contains === 'function' && first.contains(img)) {
      // An ancestor is hit first only when the image itself is not hit-testable; otherwise something the ancestor
      // paints (e.g. a pseudo-element) covers the image.
      const s = styleOf(img);
      hit = Boolean(s) && s.pointerEvents === 'none';
    }
    return hit && effectiveOpacity(img) >= 0.5;
  };

  const seen = new Set();
  const out = [];
  for (const img of document.images) {
    const srcUrl = img.currentSrc || img.src;
    if (!srcUrl || seen.has(srcUrl) || srcUrl.length > MAX_SRC) continue;
    if (!/^(https?|data|blob):/i.test(srcUrl)) continue;
    if (/^data:/i.test(srcUrl) && !/^data:image\/(?!svg)/i.test(srcUrl)) continue; // SEC-19: raster data: images only
    if (/\.svgz?(?:[?#]|$)/i.test(srcUrl)) continue;
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue; // not loaded (e.g. lazy below the fold)
    if (Math.min(img.naturalWidth, img.naturalHeight) < minNatural) continue;
    const r = img.getBoundingClientRect();
    if (Math.min(r.width, r.height) < minRendered) continue;
    if (!cssVisible(img)) continue; // SEC-13
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
      topmostAtCenter: visibleFraction > 0 ? topmostAt(img, r) : false,
    });
  }
  const visibleArea = (i) => i.rect.width * i.rect.height * i.visibleFraction;
  out.sort((a, b) => (visibleArea(b) - visibleArea(a)) || (b.rect.width * b.rect.height - a.rect.width * a.rect.height));
  return { v: 1, viewport: { width: vw, height: vh }, dpr: window.devicePixelRatio || 1, images: out.slice(0, max), total: out.length };
}
