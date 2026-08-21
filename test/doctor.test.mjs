// test/doctor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEnv, renderDoctor } from '../src/doctor.mjs';

const base = {
  has: (n) => ['node', 'git', 'claude', 'codex', 'tmux'].includes(n),
  claudeVersion: '2.1.226',
  onBattery: () => false,
  freeDiskGB: () => 200,
  dcgPresent: true,
};

test('a fully-set-up machine is ready and armable', () => {
  const r = checkEnv(base);
  assert.equal(r.ready, true);
  assert.equal(r.fatalFail, false);
  assert.equal(r.armable, true);
});

test('a missing required tool is a fatal failure', () => {
  const r = checkEnv({ ...base, has: (n) => n !== 'claude' && ['node', 'git', 'codex', 'tmux'].includes(n) });
  assert.equal(r.fatalFail, true);
  assert.equal(r.ready, false);
});

test('on battery or low disk is usable but not armable', () => {
  assert.equal(checkEnv({ ...base, onBattery: () => true }).armable, false);
  assert.equal(checkEnv({ ...base, freeDiskGB: () => 5 }).armable, false);
  assert.equal(checkEnv({ ...base, onBattery: () => true }).fatalFail, false);
});

test('an UNKNOWN power state is not armable and not shown as plugged in (round 6 #11)', () => {
  const r = checkEnv({ ...base, onBattery: () => null });
  assert.equal(r.armable, false);   // null must not pass via !null
  const ac = r.checks.find(c => c.name === 'AC power');
  assert.equal(ac.ok, false);
  assert.match(ac.detail, /unreadable/);
});

test('optional tools missing do not block readiness', () => {
  const r = checkEnv({ ...base, has: (n) => ['node', 'git', 'claude'].includes(n), dcgPresent: false });
  assert.equal(r.fatalFail, false);
  assert.equal(r.armable, true);
});

test('renderDoctor shows a verdict line', () => {
  assert.match(renderDoctor(checkEnv(base)), /ready to arm/);
  assert.match(renderDoctor(checkEnv({ ...base, has: () => false })), /not usable/);
});
