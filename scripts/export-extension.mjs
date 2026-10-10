#!/usr/bin/env node
/**
 * Copies the release build (dist/) to extension/, a ready-to-load folder that is committed to the repo,
 * so the extension can be installed from a GitHub download without Node/npm:
 * chrome://extensions → Developer mode → Load unpacked → select the extension/ folder.
 * Run after `npm run build` (npm run build:extension does both).
 */
import { cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'extension');
if (!existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('dist/ is missing; run npm run build first');
  process.exit(1);
}
await rm(OUT, { recursive: true, force: true });
await cp(DIST, OUT, { recursive: true });
console.log('extension/ updated from dist/ (load this folder in chrome://extensions)');
