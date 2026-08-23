// test/dossier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTestRunner, scanRepo, runnerAvailable, usesTransformingFilters } from '../src/dossier.mjs';
import { execFileSync } from 'node:child_process';

test('usesTransformingFilters ignores comments and a filter=lfs PATTERN token, catches a real filter attribute (round 21 #8 / round 22 #6)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cf-'));
  fs.writeFileSync(path.join(d, '.gitattributes'), '# filter=lfs disabled for now\n* text=auto\n');
  assert.equal(usesTransformingFilters(d), false);                   // comment + cosmetic text=auto → not a filter repo
  fs.writeFileSync(path.join(d, '.gitattributes'), 'filter=lfs text\n');   // "filter=lfs" is the PATTERN here, "text" the attr
  assert.equal(usesTransformingFilters(d), false);                   // must not false-positive on a pattern token
  fs.writeFileSync(path.join(d, '.gitattributes'), '*.bin filter=lfs -text\n');   // now filter=lfs is an attribute
  assert.equal(usesTransformingFilters(d), true);                    // an actual active filter line
  fs.rmSync(d, { recursive: true, force: true });
});

test('detectTestRunner uses the DECLARED package manager (pnpm/yarn/bun), not always npm (round 28 #12)', () => {
  const mk = (pkg, files = {}) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pm-'));
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg));
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
    return d;
  };
  const test = { scripts: { test: 'vitest run' } };
  assert.deepEqual(detectTestRunner(mk({ ...test, packageManager: 'pnpm@11.5.0' })), ['pnpm', 'test']);   // declared field wins
  assert.deepEqual(detectTestRunner(mk(test, { 'yarn.lock': '' })), ['yarn', 'test']);                    // lockfile fallback
  assert.deepEqual(detectTestRunner(mk(test, { 'bun.lock': '' })), ['bun', 'run', 'test']);               // bun 1.2+ text lockfile (round 29)
  assert.deepEqual(detectTestRunner(mk({ ...test, packageManager: 'bun@1.3.0' })), ['bun', 'run', 'test']); // bun needs `run` (bare `bun test` is its own runner)
  assert.deepEqual(detectTestRunner(mk(test)), ['npm', 'test']);                                          // no manager → npm (unchanged)
});

test('scanRepo marks a git-LFS / check-in-filter repo unsupported, but NOT a plain text=auto repo (round 19 A2)', () => {
  const mk = (attrs) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lfs-'));
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: d }); execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(d, '.gitattributes'), attrs);
    fs.writeFileSync(path.join(d, 'a.js'), '1');
    execFileSync('git', ['add', '-A'], { cwd: d }); execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: d });   // give it a HEAD
    return d;
  };
  const lfs = mk('*.bin filter=lfs diff=lfs merge=lfs -text\n');
  const dl = scanRepo(lfs, { hasExe: () => true });
  assert.equal(dl.canRunUnattended, false);
  assert.match(dl.unrunnableReason, /LFS|filter/i);
  fs.rmSync(lfs, { recursive: true, force: true });

  const eol = mk('* text=auto\n');                         // cosmetic line-ending normalization...
  const de = scanRepo(eol, { hasExe: () => true });
  assert.equal(de.canRunUnattended, true);                 // ...is NOT flagged unsupported
  fs.rmSync(eol, { recursive: true, force: true });
});

test('scanRepo surfaces packageManager so a test/-dir repo without scripts.test can still bootstrap its deps (round 33 HIGH)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pmsurface-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: d }); execFileSync('git', ['config', 'user.name', 't'], { cwd: d });
  // deps + declared pnpm, but NO scripts.test → detectTestRunner falls back to ['node','--test']
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ dependencies: { 'is-odd': '^3' }, packageManager: 'pnpm@8.6.0' }));
  fs.mkdirSync(path.join(d, 'test')); fs.writeFileSync(path.join(d, 'test', 'a.test.js'), '// t');
  execFileSync('git', ['add', '-A'], { cwd: d }); execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: d });
  const r = scanRepo(d, { hasExe: () => true });
  assert.deepEqual(r.testRunner, ['node', '--test']);   // the fallback runner...
  assert.equal(r.packageManager, 'pnpm');               // ...but the real pm is surfaced for the install grant
  fs.rmSync(d, { recursive: true, force: true });

  // a non-JS repo (no package.json) surfaces null — cargo/go/pytest fetch their own deps
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pmgo-'));
  execFileSync('git', ['init', '-q'], { cwd: g });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: g }); execFileSync('git', ['config', 'user.name', 't'], { cwd: g });
  fs.writeFileSync(path.join(g, 'go.mod'), 'module x\n'); fs.writeFileSync(path.join(g, 'x.go'), 'package x');
  execFileSync('git', ['add', '-A'], { cwd: g }); execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: g });
  assert.equal(scanRepo(g, { hasExe: () => true }).packageManager, null);
  fs.rmSync(g, { recursive: true, force: true });
});

test('scanRepo marks an UNBORN repo (no commits) non-runnable with a clear reason (round 18 #8)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-unborn-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));  // a runner IS present...
  const dossier = scanRepo(d, { hasExe: () => true });   // ...and its executable resolves (real git → real unborn HEAD)
  assert.equal(dossier.unborn, true);
  assert.equal(dossier.canRunUnattended, false);         // ...but no commits → not runnable, so it never becomes a card
  assert.match(dossier.unrunnableReason, /no commits/i);
  fs.rmSync(d, { recursive: true, force: true });
});

function tmp(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dos-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(d, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), content);
  }
  return d;
}

test('detects npm test from package.json', () => {
  const d = tmp({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  assert.deepEqual(detectTestRunner(d), ['npm', 'test']);
});

test('detects cargo / go / pytest by manifest', () => {
  assert.deepEqual(detectTestRunner(tmp({ 'Cargo.toml': '' })), ['cargo', 'test']);
  assert.deepEqual(detectTestRunner(tmp({ 'go.mod': 'module x' })), ['go', 'test', './...']);
  assert.deepEqual(detectTestRunner(tmp({ 'pyproject.toml': '' })), ['pytest', '-q']);
});

test('returns null when no runner is detectable', () => {
  assert.equal(detectTestRunner(tmp({ 'README.md': 'hi' })), null);
});

test('ignores the npm placeholder test script', () => {
  const d = tmp({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.equal(detectTestRunner(d), null);
});

test('scanRepo reports runner + canRunUnattended', () => {
  const d = tmp({ 'Cargo.toml': '', 'RESUME.md': 'x' });
  const dossier = scanRepo(d, { gitRunner: () => '', hasExe: () => true });   // cargo present
  assert.deepEqual(dossier.testRunner, ['cargo', 'test']);
  assert.equal(dossier.canRunUnattended, true);
  assert.equal(dossier.hasResume, true);
});

test('a detected runner whose executable is MISSING is not runnable unattended (round 4 #11)', () => {
  const d = tmp({ 'pyproject.toml': '' });
  const dossier = scanRepo(d, { gitRunner: () => '', hasExe: () => false });   // pytest not installed
  assert.deepEqual(dossier.testRunner, ['pytest', '-q']);   // still detected...
  assert.equal(dossier.runnerReady, false);
  assert.equal(dossier.canRunUnattended, false);            // ...but not gradeable
});

test('runnerAvailable is false for an empty/absent runner', () => {
  assert.equal(runnerAvailable(null, { hasExe: () => true }), false);
  assert.equal(runnerAvailable([], { hasExe: () => true }), false);
  assert.equal(runnerAvailable(['npm', 'test'], { hasExe: () => true }), true);
});
