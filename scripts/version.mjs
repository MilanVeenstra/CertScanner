#!/usr/bin/env node
// Extension version rules for the Chrome Web Store, and the sync step of `npm version`.
//   npm version patch|minor|major  -> npm bumps package.json, then runs `node scripts/version.mjs --sync` (the "version"
//                                     script) so src/manifest.json gets the same version before npm commits and tags vX.Y.Z.
// The release workflow (.github/workflows/release.yml) builds and publishes that tag; `npm run check` refuses a
// manifest whose version differs from package.json.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_RE = /"version"\s*:\s*"[^"]*"/;

/** Chrome's manifest "version": 1-4 dot-separated integers 0-65535, no leading zeros, not all zero. */
export function isStoreVersion(v) {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(v)) return false;
  const parts = v.split('.').map(Number);
  return parts.every((n) => n <= 65535) && parts.some((n) => n > 0);
}

/** The manifest text with its "version" set to `version`; everything else (formatting, key order) is kept. */
export function withVersion(manifestRaw, version) {
  if (!isStoreVersion(version)) throw new RangeError(`"${version}" is not a valid extension version (1-4 integers 0-65535)`);
  if (!VERSION_RE.test(manifestRaw)) throw new Error('manifest has no "version"');
  return manifestRaw.replace(VERSION_RE, `"version": "${version}"`);
}

async function sync() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const file = path.join(ROOT, 'src', 'manifest.json');
  const raw = await readFile(file, 'utf8');
  const next = withVersion(raw, pkg.version);
  if (next !== raw) await writeFile(file, next);
  console.log(`src/manifest.json version ${pkg.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--sync')) {
    sync().catch((e) => { console.error(e.message); process.exit(1); });
  } else {
    console.error('Usage: node scripts/version.mjs --sync  (run by `npm version`)');
    process.exit(2);
  }
}
