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

// Crashed clones are quarantined and PRESERVED forever by design (never auto-deleted — they may
// hold the only copy of a night's work). Left invisible they pile up until the <20GB disk check
// silently blocks arming with no hint of the cause. doctor surfaces the backlog so the owner can
// review and clear it — advisory only, never fatal, never affecting armability.
test('a quarantine backlog is surfaced, non-fatal, and does not block arming', () => {
  const r = checkEnv({ ...base, quarantine: () => ({ count: 42, sizeMB: 240 }) });
  const q = r.checks.find(c => c.name === 'quarantine');
  assert.ok(q, 'a quarantine row is present when the probe reports a backlog');
  assert.equal(q.ok, false);
  assert.equal(q.fatal, false);
  assert.match(q.detail, /42/);                       // the count is shown
  assert.match(q.detail, /clear|review|reclaim/i);    // and how to act on it
  assert.equal(r.armable, true);                      // advisory only — arming is unaffected
  assert.equal(r.fatalFail, false);
});

test('zero quarantined clones is a clean check', () => {
  const q = checkEnv({ ...base, quarantine: () => ({ count: 0 }) }).checks.find(c => c.name === 'quarantine');
  assert.equal(q.ok, true);
});

test('an unreadable quarantine probe is non-fatal and does not block arming', () => {
  const r = checkEnv({ ...base, quarantine: () => null });
  const q = r.checks.find(c => c.name === 'quarantine');
  assert.equal(q.ok, false);
  assert.equal(q.fatal, false);
  assert.equal(r.armable, true);
});

test('no quarantine probe means no quarantine row (backward compatible)', () => {
  assert.equal(checkEnv(base).checks.find(c => c.name === 'quarantine'), undefined);
});
