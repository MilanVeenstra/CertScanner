// SEC-15 release packaging, run against a throw-away git repository holding a copy of the build inputs:
// ignored/untracked files and third_party/ edits make the tree dirty, --allow-dirty ZIPs are named -dirty,
// builtAt defaults to the HEAD commit time, and vendor files are pinned by sha256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMIT_EPOCH = 1760000000;
const hasGit = spawnSync('git', ['--version']).status === 0;
const hasVendor = existsSync(path.join(ROOT, 'node_modules', 'zxing-wasm', 'package.json'));

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'certscanner-build-'));
  for (const p of ['src', 'third_party', 'scripts/build.mjs', 'package.json', 'package-lock.json']) {
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n/dist/\n/dist-e2e/\n*.zip\n*.local\n');
  const env = { ...process.env, GIT_AUTHOR_DATE: `@${COMMIT_EPOCH} +0000`, GIT_COMMITTER_DATE: `@${COMMIT_EPOCH} +0000` };
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return dir;
}

function build(dir, ...args) {
  const env = { ...process.env };
  delete env.SOURCE_DATE_EPOCH;
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'build.mjs'), ...args], { cwd: dir, env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('SEC-15 packaging: clean commit, ignored/untracked/third_party changes refused, -dirty name, commit-time builtAt', { skip: !hasGit || !hasVendor, timeout: 180_000 }, () => {
  const dir = makeRepo();
  try {
    const clean = build(dir, '--package');
    assert.equal(clean.code, 0, clean.out);
    assert.ok(existsSync(path.join(dir, 'certscanner-0.1.0.zip')));
    const info = JSON.parse(readFileSync(path.join(dir, 'dist', 'build-info.json'), 'utf8'));
    assert.equal(info.gitDirty, false);
    assert.equal(info.builtAt, new Date(COMMIT_EPOCH * 1000).toISOString(), 'builtAt defaults to the HEAD commit time');

    // An ignored file under src/ would be copied into dist/: the tree is dirty.
    writeFileSync(path.join(dir, 'src', 'stowaway.local'), 'x');
    const ignored = build(dir, '--package');
    assert.equal(ignored.code, 1);
    assert.match(ignored.out, /refusing to package: gitDirty=true.*stowaway\.local/);

    // --allow-dirty: a test package with a distinct name.
    rmSync(path.join(dir, 'certscanner-0.1.0.zip'));
    const allowed = build(dir, '--package', '--allow-dirty');
    assert.equal(allowed.code, 0, allowed.out);
    assert.ok(existsSync(path.join(dir, 'certscanner-0.1.0-dirty.zip')));
    assert.ok(!existsSync(path.join(dir, 'certscanner-0.1.0.zip')));
    rmSync(path.join(dir, 'src', 'stowaway.local'));

    // A licence text under third_party/ edited without a commit.
    const readme = readdirSync(path.join(dir, 'third_party', 'licenses'))[0];
    appendFileSync(path.join(dir, 'third_party', 'licenses', readme), '\nedited\n');
    const licence = build(dir, '--package');
    assert.equal(licence.code, 1);
    assert.match(licence.out, /refusing to package: gitDirty=true.*third_party/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SEC-15 vendor pins: a changed vendor file in node_modules fails the build', { skip: !hasGit || !hasVendor, timeout: 120_000 }, () => {
  const dir = makeRepo();
  try {
    rmSync(path.join(dir, 'node_modules'));
    mkdirSync(path.join(dir, 'node_modules'));
    const real = path.join(ROOT, 'node_modules');
    for (const name of readdirSync(real)) {
      if (name === 'zxing-wasm') cpSync(path.join(real, name), path.join(dir, 'node_modules', name), { recursive: true });
      else symlinkSync(path.join(real, name), path.join(dir, 'node_modules', name));
    }
    appendFileSync(path.join(dir, 'node_modules', 'zxing-wasm', 'dist', 'iife', 'reader', 'index.js'), '\n// tampered\n');
    const r = build(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /vendor sha256 mismatch for node_modules\/zxing-wasm\/dist\/iife\/reader\/index\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
