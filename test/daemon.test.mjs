// test/daemon.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armChecks, reconcile, reap } from '../src/daemon.mjs';

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
