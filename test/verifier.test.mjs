// test/verifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance, netLinesGutted, patchApplied, classifyClaim, suspiciousDeletion, verifyCard } from '../src/verifier.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpGit() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pa-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'hi'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  return d;
}

test('patchApplied is false when nothing changed, true after an edit', () => {
  const d = tmpGit();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  assert.equal(patchApplied(d, base), false);
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed');
  assert.equal(patchApplied(d, base), true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('classifyClaim flags false-done when the agent claims done but tests fail', () => {
  assert.deepEqual(classifyClaim({ claimText: 'All tests pass, done!', verifyPass: false }), { claimedDone: true, falseDone: true });
  assert.deepEqual(classifyClaim({ claimText: 'done', verifyPass: true }), { claimedDone: true, falseDone: false });
  assert.deepEqual(classifyClaim({ claimText: 'I could not fix it', verifyPass: false }), { claimedDone: false, falseDone: false });
});

test('runAcceptance passes on exit 0', async () => {
  const r = await runAcceptance(['node', '-e', 'process.exit(0)'], process.cwd(), 30);
  assert.equal(r.pass, true);
  assert.equal(r.code, 0);
});

test('runAcceptance fails on nonzero exit and captures stderr head', async () => {
  const r = await runAcceptance(['node', '-e', 'console.error("boom"); process.exit(1)'], process.cwd(), 30);
  assert.equal(r.pass, false);
  assert.match(r.stderrHead, /boom/);
});

test('runAcceptance times out', async () => {
  const r = await runAcceptance(['node', '-e', 'setTimeout(()=>{}, 10000)'], process.cwd(), 1);
  assert.equal(r.pass, false);
  assert.equal(r.timedOut, true);
});

test('runAcceptance drains a chatty stdout instead of deadlocking (round 5 M1)', async () => {
  // Write ~2MB to stdout then exit 0 — would block on a full pipe if stdout were unconsumed.
  const r = await runAcceptance(['node', '-e', 'process.stdout.write("x".repeat(2_000_000)); process.exit(0)'], process.cwd(), 20);
  assert.equal(r.pass, true);       // completed, not a false timeout
  assert.equal(r.timedOut, false);
});

test('runAcceptance captures a failure reported on STDOUT, not just stderr (round 5 M1)', async () => {
  const r = await runAcceptance(['node', '-e', 'console.log("FAIL: expected 2 got 3"); process.exit(1)'], process.cwd(), 20);
  assert.equal(r.pass, false);
  assert.match(r.stderrHead, /FAIL: expected 2/);   // stdout diagnostics are now surfaced
});

test('verifyCard refuses a destructive diff even when the test passes (round 5 H1)', async () => {
  const d = tmpGit();
  // the feature exists AT base...
  fs.writeFileSync(path.join(d, 'feature.js'), Array.from({ length: 80 }, (_, i) => `const l${i}=${i};`).join('\n'));
  execFileSync('git', ['add', '-A'], { cwd: d }); execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: d });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  // ...then the "agent" guts it while the (trivial) test still passes
  fs.writeFileSync(path.join(d, 'feature.js'), 'const l0=0;');
  const card = { goal: 'add a gallery feature', acceptanceArgv: ['node', '-e', 'process.exit(0)'], acceptanceTimeoutSec: 20 };
  const v = await verifyCard(card, d, { baseRef: base });
  assert.equal(v.pass, false);
  assert.match(v.detail.testOutput, /net-negative|refusing/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('verifyCard passes a clean additive diff (round 5 H1)', async () => {
  const d = tmpGit();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  fs.writeFileSync(path.join(d, 'feature.js'), 'export const feature = () => 42;');
  const card = { goal: 'add a feature', acceptanceArgv: ['node', '-e', 'process.exit(0)'], acceptanceTimeoutSec: 20 };
  const v = await verifyCard(card, d, { baseRef: base });
  assert.equal(v.pass, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('netLinesGutted flags a net-negative diff', () => {
  assert.equal(netLinesGutted(' 3 files changed, 2 insertions(+), 40 deletions(-)'), true);
  assert.equal(netLinesGutted(' 3 files changed, 40 insertions(+), 2 deletions(-)'), false);
});

test('suspiciousDeletion catches a net-negative diff on a build goal, ignores refactors', () => {
  const gutted = ' 1 file changed, 2 insertions(+), 90 deletions(-)';
  assert.equal(suspiciousDeletion('add a lazy-load feature to the gallery', gutted), true);
  assert.equal(suspiciousDeletion('remove the dead code path', gutted), false);   // deletion IS the goal
  assert.equal(suspiciousDeletion('add a feature', ' 1 file changed, 90 insertions(+), 2 deletions(-)'), false);
});
