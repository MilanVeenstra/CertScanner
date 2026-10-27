// Geometry for the grade check: lines, quadrilaterals and homographies. Pure and DOM-free (unit-tested in Node).
// Points are [x, y] in continuous image coordinates: pixel (i, j) covers [i, i+1] × [j, j+1], its centre is (i+.5, j+.5).

/** Solve A·x = b for a small dense system (Gaussian elimination, partial pivoting). Null when singular. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Homography (row-major 3×3, h33 = 1) that maps the 4 `from` points onto the 4 `to` points. Null when degenerate. */
export function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return h && h.every(Number.isFinite) ? [...h, 1] : null;
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Line a·x + b·y = c with (a, b) a unit normal. */
export function lineThrough(p, q) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  const a = -dy / len;
  const b = dx / len;
  return { a, b, c: a * p[0] + b * p[1] };
}

/** Line from Hough parameters: x·cosθ + y·sinθ = ρ. */
export const lineFromPolar = (theta, rho) => ({ a: Math.cos(theta), b: Math.sin(theta), c: rho });

export function intersect(l1, l2) {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-9) return null;
  return [(l1.c * l2.b - l2.c * l1.b) / det, (l1.a * l2.c - l2.a * l1.c) / det];
}

export const distToLine = (l, x, y) => l.a * x + l.b * y - l.c;

/**
 * Robust total-least-squares line through points: refit without points further than 3 robust sigmas (at least
 * `minResidual` px). Returns null with fewer than `minPoints` points.
 * @returns {{a:number, b:number, c:number, inliers:number, rms:number}|null}
 */
export function fitLine(points, { iterations = 3, minResidual = 0.5, minPoints = 4 } = {}) {
  let pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  let line = null;
  for (let it = 0; it <= iterations; it++) {
    if (pts.length < minPoints) return line;
    let mx = 0; let my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0; let sxy = 0; let syy = 0;
    for (const [x, y] of pts) { const dx = x - mx; const dy = y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    // Direction = eigenvector of the largest eigenvalue of the scatter matrix; the normal is perpendicular to it.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const a = -Math.sin(theta);
    const b = Math.cos(theta);
    const res = pts.map(([x, y]) => Math.abs(a * x + b * y - (a * mx + b * my)));
    const sorted = [...res].sort((p, q) => p - q);
    const mad = sorted[sorted.length >> 1] * 1.4826;
    const rms = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length);
    line = { a, b, c: a * mx + b * my, inliers: pts.length, rms };
    if (it === iterations) break;
    const limit = Math.max(minResidual, 3 * mad);
    const keep = pts.filter((_, i) => res[i] <= limit);
    if (keep.length === pts.length) break;
    pts = keep;
  }
  return line;
}

export function quadArea(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) { const [x1, y1] = q[i]; const [x2, y2] = q[(i + 1) % 4]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2;
}

export function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i]; const [bx, by] = q[(i + 1) % 4]; const [cx, cy] = q[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-9) return false;
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/**
 * The 4 corners in card order for a portrait card: top-left, top-right, bottom-right, bottom-left (clockwise on screen,
 * y down). The top side is a short side: the upper one, or for a card lying sideways, the left one.
 */
export function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const cw = [...pts].sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx)); // clockwise on screen
  // Side i runs from cw[i] to cw[i+1]. Sides 0/2 and 1/3 are opposite: the shorter pair are the card's short sides.
  const len = (i) => dist(cw[i], cw[(i + 1) % 4]);
  const shortStart = len(0) + len(2) <= len(1) + len(3) ? 0 : 1;
  const mid = (i) => [(cw[i][0] + cw[(i + 1) % 4][0]) / 2, (cw[i][1] + cw[(i + 1) % 4][1]) / 2];
  const a = mid(shortStart);
  const b = mid(shortStart + 2);
  const upright = Math.abs(a[1] - b[1]) >= Math.abs(a[0] - b[0]);
  const top = upright ? (a[1] <= b[1] ? shortStart : shortStart + 2) : (a[0] <= b[0] ? shortStart : shortStart + 2);
  return [0, 1, 2, 3].map((k) => cw[(top + k) % 4]);
}

const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

/**
 * Width/height of the real rectangle behind a perspective quad (TL, TR, BR, BL), assuming a pinhole camera with its
 * principal point at `center` and square pixels (Zhang & He, "Whiteboard scanning and image enhancement", 2007).
 * Falls back to the affine estimate (mean opposite side lengths) when the focal length can't be recovered.
 */
export function rectAspect(quad, center) {
  const [tl, tr, br, bl] = quad;
  const affine = (dist(tl, tr) + dist(bl, br)) / (dist(tl, bl) + dist(tr, br));
  const [u0, v0] = center;
  const m1 = [tl[0], tl[1], 1]; const m2 = [tr[0], tr[1], 1]; const m3 = [bl[0], bl[1], 1]; const m4 = [br[0], br[1], 1];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  const denom = n2[2] * n3[2];
  const scale = Math.max(Math.abs(n2[0]), Math.abs(n2[1]), Math.abs(n3[0]), Math.abs(n3[1]), 1);
  if (!Number.isFinite(k2) || !Number.isFinite(k3) || Math.abs(denom) < 1e-8 * scale * scale) return affine;
  const f2 = -((n2[0] - n2[2] * u0) * (n3[0] - n3[2] * u0) + (n2[1] - n2[2] * v0) * (n3[1] - n3[2] * v0)) / denom;
  const diag = Math.hypot(u0 * 2, v0 * 2);
  if (!(f2 > (0.25 * diag) ** 2 && f2 < (8 * diag) ** 2)) return affine; // implausible focal length: little perspective
  const norm = (n) => ((n[0] - u0 * n[2]) ** 2 + (n[1] - v0 * n[2]) ** 2) / f2 + n[2] ** 2;
  const r = Math.sqrt(norm(n2) / norm(n3));
  return Number.isFinite(r) && r > 0 ? r : affine;
}

/** Largest angle (degrees) between opposite sides of a quad: 0 for a frontal photo, larger with more perspective. */
export function quadSkew(q) {
  const ang = (p, r) => Math.atan2(r[1] - p[1], r[0] - p[0]);
  const diff = (x, y) => { let d = Math.abs(x - y) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d * 180 / Math.PI; };
  return Math.max(diff(ang(q[0], q[1]), ang(q[3], q[2])), diff(ang(q[0], q[3]), ang(q[1], q[2])));
}
