// Official card faces for the grade-check benchmark (bench:grade --faces): the renders listed in
// tests/bench/official/faces.json, fetched into .cache/grade-data/official/ by scripts/fetch-grade-data.mjs --faces.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FACES_LIST = path.join(ROOT, 'tests/bench/official/faces.json');
export const FACES_DIR = path.join(ROOT, '.cache/grade-data/official');

/** The listed faces with their decoded images: [{id, name, img, borders, cornerRadiusMm}]. Throws when one is missing. */
export function loadFaces(dir = FACES_DIR) {
  const { faces } = JSON.parse(readFileSync(FACES_LIST, 'utf8'));
  const missing = faces.filter((f) => !existsSync(path.join(dir, `${f.id}.png`)));
  if (missing.length) throw new Error(`${missing.length} card faces missing in ${path.relative(ROOT, dir)}: run node scripts/fetch-grade-data.mjs --faces`);
  return faces.map((f) => ({ ...f, img: decodePng(readFileSync(path.join(dir, `${f.id}.png`))) }));
}
