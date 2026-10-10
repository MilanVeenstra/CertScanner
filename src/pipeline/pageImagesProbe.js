// A9 page discovery. Injected with chrome.scripting.executeScript({func: pageImagesProbe}) into the MAIN FRAME,
// ISOLATED world. Chrome serializes func.toString(): this function MUST be self-contained (no imports, no closure
// variables). It reads image URLs and geometry only (no page text, no DOM content) and leaves nothing behind.
// The return value is UNTRUSTED until validatePageImages() (src/pipeline/probeValidate.js) passes.

/**
 * SEC-13/SEC-20: images hidden with CSS (display/visibility/content-visibility, opacity 0) are skipped. For each
 * image the probe reports `topmostAtCenter` (true = "prominent-ready": the user sees this image itself):
 * - neither the image nor any ancestor has a `filter`, `clip-path`, legacy `clip`, `mask-image`/`-webkit-mask-image`
 *   or a `mix-blend-mode` other than normal, and the cumulative opacity (image x ancestors) is at least 0.9;
 * - at >= 4 of 5 points of its visible part (centre and 25 %/75 % of width and height) the image itself is the first
 *   element `elementsFromPoint` returns, and no `pointer-events:none` element that paints (replaced/SVG element,
 *   background, backdrop-filter or a painted ::before/::after) covers the point. Hit testing never reports
 *   `pointer-events:none` elements, so they are looked up by their boxes; their z-order is unknown, so any such element
 *   over the point counts as covering.
 * Page routing auto-opens only for prominent images (see core/pageAggregate.js). `total` counts every qualifying
 * image before the cap (O10).
 * @param {{minRendered?:number, minNatural?:number, max?:number}} opts
 * @returns {Promise<{v:1, viewport:{width:number,height:number}, dpr:number, images:object[], total:number}>}
 */
export async function pageImagesProbe(opts) {
  const minRendered = (opts && opts.minRendered) || 120;
  const minNatural = (opts && opts.minNatural) || 150;
  const max = (opts && opts.max) || 24;
  const MAX_SRC = 2000000;
  const MAX_ANCESTORS = 256;
  const MAX_ELEMENTS = 30000; // pointer-events:none lookup; larger documents can't be vouched for
  const MIN_OPACITY = 0.9;
  const MIN_POINTS = 4;
  const REPLACED = new Set(['IMG', 'PICTURE', 'CANVAS', 'VIDEO', 'SVG', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT']);
  let dataBudget = 8000000; // total chars of data: URLs returned (IPC size guard)
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return null; } };
  const originOf = (u) => {
    try { const x = new URL(u); return x.protocol === 'blob:' ? new URL(x.pathname).origin : x.origin; } catch { return null; }
  };
  const styleOf = (el, pseudo) => { try { return window.getComputedStyle(el, pseudo || null); } catch { return null; } };
  const prop = (st, name, camel) => {
    try { return String((typeof st.getPropertyValue === 'function' ? st.getPropertyValue(name) : '') || st[camel] || ''); } catch { return ''; }
  };
  const isSet = (v, none) => Boolean(v) && v !== none && !(none === 'none' && /^none\b/.test(v));
  const transparent = (c) => !c || c === 'transparent' || /,\s*0(?:\.0+)?\s*\)$/.test(c);
  /** CSS-hidden (display:none, visibility:hidden, content-visibility, opacity:0 anywhere up the tree)? */
  const cssVisible = (el) => {
    if (typeof el.checkVisibility !== 'function') return true; // feature-detect (Chrome 105+)
    try {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
    } catch { return true; }
  };
  /** Rule 1: no filter/clip/mask/blend on the image or an ancestor, cumulative opacity >= 0.9. */
  const undistorted = (img) => {
    let o = 1;
    let el = img;
    let k = 0;
    for (; el && k < MAX_ANCESTORS; k++, el = el.parentElement) {
      const st = styleOf(el);
      if (!st) return false;
      if (isSet(prop(st, 'filter', 'filter'), 'none') || isSet(prop(st, 'clip-path', 'clipPath'), 'none')
        || isSet(prop(st, 'mask-image', 'maskImage'), 'none') || isSet(prop(st, '-webkit-mask-image', 'webkitMaskImage'), 'none')
        || isSet(prop(st, 'mask', 'mask'), 'none') || /^rect/i.test(prop(st, 'clip', 'clip'))) return false;
      const blend = prop(st, 'mix-blend-mode', 'mixBlendMode');
      if (blend && blend !== 'normal') return false;
      const v = Number.parseFloat(prop(st, 'opacity', 'opacity'));
      if (Number.isFinite(v)) o *= Math.min(1, Math.max(0, v));
    }
    return !el && o >= MIN_OPACITY; // a chain longer than MAX_ANCESTORS can't be vouched for
  };
  const paints = (st) => isSet(prop(st, 'background-image', 'backgroundImage'), 'none')
    || !transparent(prop(st, 'background-color', 'backgroundColor'))
    || isSet(prop(st, 'backdrop-filter', 'backdropFilter'), 'none');
  /** Visible, painting elements with pointer-events:none (hit tests skip them). null = too many elements to check. */
  let inert;
  const inertPainters = () => {
    if (inert !== undefined) return inert;
    const els = [];
    const collect = (root) => {
      for (const el of root.querySelectorAll('*')) {
        els.push(el);
        if (els.length > MAX_ELEMENTS) return false;
        let sr = el.shadowRoot || null;
        // Closed roots are looked up for custom elements only: one API call per element would cost ~80 ms on a
        // 24k-element page. Residual: a closed root on a standard element (div, span, ...) is not searched.
        if (!sr && String(el.tagName || '').includes('-') && globalThis.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
          try { sr = chrome.dom.openOrClosedShadowRoot(el); } catch { sr = null; }
        }
        if (sr && collect(sr) === false) return false;
      }
      return true;
    };
    let complete = false;
    try {
      // Cheap native count first: a document already over the cap fails closed without walking it.
      const count = typeof document.getElementsByTagName === 'function' ? document.getElementsByTagName('*').length : 0;
      complete = count <= MAX_ELEMENTS && collect(document);
    } catch { complete = false; }
    if (!complete) { inert = null; return inert; } // fail closed: not prominent
    inert = [];
    const viewportBox = { left: 0, top: 0, width: vw, height: vh };
    const union = (a, b) => {
      const left = Math.min(a.left, b.left);
      const top = Math.min(a.top, b.top);
      return { left, top, width: Math.max(a.left + a.width, b.left + b.width) - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
    };
    /** Box of the nearest ancestor-or-self that positions absolute descendants (approximation of the containing block). */
    const containingBox = (el) => {
      for (let a = el, k = 0; a && k < MAX_ANCESTORS; a = a.parentElement, k++) {
        const st = styleOf(a);
        const position = st ? prop(st, 'position', 'position') : '';
        if (st && ((position && position !== 'static') || isSet(prop(st, 'transform', 'transform'), 'none'))) {
          try { return a.getBoundingClientRect(); } catch { return viewportBox; }
        }
      }
      return viewportBox;
    };
    for (const el of els) {
      let r;
      try { r = el.getBoundingClientRect(); } catch { continue; }
      if (r.left + r.width < 0 || r.top + r.height < 0 || r.left > vw || r.top > vh) continue; // off-screen (0-size kept)
      const st = styleOf(el);
      if (!st || prop(st, 'pointer-events', 'pointerEvents') !== 'none' || !cssVisible(el)) continue;
      const tag = String(el.tagName || '').toUpperCase();
      const sized = r.width > 0 && r.height > 0;
      if (sized && (REPLACED.has(tag) || String(el.namespaceURI || '').endsWith('/2000/svg') || paints(st))) inert.push({ el, r });
      for (const pseudo of ['::before', '::after']) {
        const ps = styleOf(el, pseudo);
        const content = ps ? prop(ps, 'content', 'content') : '';
        if (!content || content === 'none' || content === 'normal' || !(paints(ps) || /url\(/i.test(content))) continue;
        // A positioned pseudo-element can sit anywhere in its containing block; its own box can't be measured.
        const pos = prop(ps, 'position', 'position');
        if (pos === 'fixed') inert.push({ el, r: viewportBox });
        else if (pos === 'absolute') inert.push({ el, r: union(r, containingBox(el)) });
        else if (sized) inert.push({ el, r });
      }
    }
    return inert;
  };
  /** Rule 2: the image itself is on top at >= 4 of 5 points of its visible part. */
  const topmostAt = (img, r) => {
    const x0 = Math.max(r.left, 0);
    const y0 = Math.max(r.top, 0);
    const x1 = Math.min(r.left + r.width, vw);
    const y1 = Math.min(r.top + r.height, vh);
    if (!(x1 > x0 && y1 > y0)) return false;
    if (!undistorted(img)) return false;
    const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([fx, fy]) => [x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy]);
    let good = 0;
    for (const [x, y] of points) {
      let first = null;
      try {
        const hits = document.elementsFromPoint(x, y);
        first = hits && hits.length ? hits[0] : null;
      } catch { first = null; }
      if (!first || !(first === img || (typeof img.contains === 'function' && img.contains(first)))) continue;
      const covers = inertPainters();
      if (covers === null) return false;
      const covered = covers.some(({ el, r: b }) => el !== img && !(typeof el.contains === 'function' && el.contains(img))
        && x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height);
      if (!covered) good++;
    }
    return good >= MIN_POINTS;
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
