// test/daemon.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armChecks, reconcile, reap, reapClone } from '../src/daemon.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('armChecks refuses on battery', () => {
  const c = armChecks({ onBattery: () => true, freeDiskGB: () => 500 });
  assert.equal(c.ok, false);
  assert.ok(c.warnings.some(w => /battery/i.test(w)));
});

test('armChecks refuses on low disk', () => {
  const c = armChecks({ onBattery: () => false, freeDiskGB: () => 5 });
  assert.equal(c.ok, false);
  assert.ok(c.warnings.some(w => /disk/i.test(w)));
});

test('armChecks passes on AC with headroom', () => {
  const c = armChecks({ onBattery: () => false, freeDiskGB: () => 200 });
  assert.equal(c.ok, true);
  assert.equal(c.warnings.length, 0);
});

test('armChecks fails CLOSED when the power probe is unreadable (round 4 #9)', () => {
  const c = armChecks({ onBattery: () => null, freeDiskGB: () => 200 });
  assert.equal(c.ok, false);
  assert.ok(c.warnings.some(w => /power state/i.test(w)));
});

test('armChecks fails CLOSED on an unreadable / NaN / Infinite disk probe (round 4 #9)', () => {
  for (const bad of [null, NaN, Infinity]) {
    const c = armChecks({ onBattery: () => false, freeDiskGB: () => bad });
    assert.equal(c.ok, false, `disk=${bad} must refuse`);
    assert.ok(c.warnings.some(w => /disk/i.test(w)));
  }
});

test('reconcile reports clones not tied to an active branch as orphans', () => {
  const orphans = reconcile({ workDir: '/w', list: () => ['ghost_a', 'ghost_stale'], activeBranches: ['ghost/a'] });
  assert.deepEqual(orphans, ['ghost_stale']);
});

test('reap removes everything not in keep', () => {
  const removed = [];
  const out = reap({ workDir: '/w', keep: ['ghost_keep'], list: () => ['ghost_keep', 'ghost_old1', 'ghost_old2'], rm: (p) => removed.push(p) });
  assert.deepEqual(out, ['ghost_old1', 'ghost_old2']);
  assert.equal(removed.length, 2);
});

test('reap refuses to escape the work dir via .. or absolute names (M2)', () => {
  const removed = [];
  reap({ workDir: '/w', keep: [], list: () => ['../etc', '/etc/passwd', 'ghost_ok'], rm: (p) => removed.push(p) });
  assert.deepEqual(removed, ['/w/ghost_ok']);   // only the contained child was removed
});

test('orphaned clones from a crashed night are preserved, not reaped (round 5 H2)', () => {
  const present = ['ghost_active', 'ghost_orphan_from_crash'];
  // reconcile identifies the crash orphan (a clone not tied to any active branch)...
  const orphans = reconcile({ workDir: '/w', list: () => present, activeBranches: ['ghost/active'] });
  assert.deepEqual(orphans, ['ghost_orphan_from_crash']);
  // ...and adding it to the keep-list means reap leaves the unfinished work alone.
  const removed = [];
  reap({ workDir: '/w', keep: ['ghost_active', ...orphans], list: () => present, rm: (p) => removed.push(p) });
  assert.deepEqual(removed, []);
});

test('reapClone removes one completed clone so successful clones do not accumulate (round 18 #9)', () => {
  const removed = [];
  const ok = reapClone('ghost_done', { workDir: '/w', rm: (p) => removed.push(p) });
  assert.equal(ok, true);
  assert.deepEqual(removed, ['/w/ghost_done']);
});

test('reapClone refuses to escape the work dir via .. or an absolute name (round 18 #9)', () => {
  const removed = [];
  assert.equal(reapClone('../etc', { workDir: '/w', rm: (p) => removed.push(p) }), false);
  assert.equal(reapClone('/etc/passwd', { workDir: '/w', rm: (p) => removed.push(p) }), false);
  assert.deepEqual(removed, []);   // nothing outside the work dir is touched
});

test('reapClone refuses a SYMLINKED work root — deletes nothing (shares reap guard) (round 18 #9)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-reapc-'));
  const realWork = path.join(base, 'real'); fs.mkdirSync(realWork);
  fs.mkdirSync(path.join(realWork, 'ghost_done'));
  const linkWork = path.join(base, 'link'); fs.symlinkSync(realWork, linkWork);
  const removed = [];
  assert.equal(reapClone('ghost_done', { workDir: linkWork, rm: (p) => removed.push(p) }), false);
  assert.deepEqual(removed, []);
  assert.ok(fs.existsSync(path.join(realWork, 'ghost_done')));   // untouched through the symlink
  fs.rmSync(base, { recursive: true, force: true });
});

test('reap refuses a SYMLINKED work root outright — deletes nothing (round 4: no test covered this)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-reap-'));
  const realWork = path.join(base, 'real'); fs.mkdirSync(realWork);
  fs.writeFileSync(path.join(realWork, 'ghost_old'), 'x');
  const linkWork = path.join(base, 'link'); fs.symlinkSync(realWork, linkWork);
  const removed = [];
  const out = reap({ workDir: linkWork, keep: [], list: () => ['ghost_old'], rm: (p) => removed.push(p) });
  assert.deepEqual(out, []);            // refused via lstat — nothing removed through the symlink
  assert.deepEqual(removed, []);
  fs.rmSync(base, { recursive: true, force: true });
});
