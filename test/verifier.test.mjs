// test/verifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance, netLinesGutted, patchApplied, classifyClaim, suspiciousDeletion, verifyCard, destructiveDiffReason } from '../src/verifier.mjs';
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

test('runAcceptance runs with a credential-stripped environment (round 6 #1)', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'super-secret';
  try {
    // the test command "fails" (exit 1) only if it can see the key — it should NOT
    const r = await runAcceptance(['node', '-e', 'process.exit(process.env.ANTHROPIC_API_KEY ? 1 : 0)'], process.cwd(), 20);
    assert.equal(r.pass, true, 'acceptance env leaked ANTHROPIC_API_KEY');
  } finally { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; }
});

test('runAcceptance kills the whole process group on timeout — a grandchild cannot deadlock it (round 6 #1)', async () => {
  const start = Date.now();
  // parent spawns a grandchild that INHERITS stdout and never exits, then the parent hangs too.
  const script = "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000);";
  const r = await runAcceptance(['node', '-e', script], process.cwd(), 1);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - start < 6000, 'returned promptly — the grandchild did not hold it open');
});

test('runAcceptance settles at the deadline even when a grandchild ESCAPES the process group (round 7 High#1)', async () => {
  const start = Date.now();
  // grandchild is spawned DETACHED (its own group) inheriting stdout — it survives kill(-pid),
  // so 'close' is delayed ~3s. We must still resolve at the ~1s deadline, not wait for it.
  const script = "const{spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:'inherit',detached:true});g.unref();setInterval(()=>{},1000);";
  const r = await runAcceptance(['node', '-e', script], process.cwd(), 1);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - start < 2500, `settled at the deadline, not on the grandchild's exit (${Date.now() - start}ms)`);
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

test('destructiveDiffReason catches gutting under a non-build goal and deleted tests (round 6 #3)', () => {
  // "fix" goal (no build word) that guts a file 500→1 — old guard missed this
  assert.match(destructiveDiffReason('fix the parser', '1\t500\tsrc/parser.js', 'M\tsrc/parser.js'), /500 net lines|lost/);
  // padded net-POSITIVE total (501 add / 500 del) but a test file is deleted
  assert.match(destructiveDiffReason('make it pass', '501\t0\tpad.js\n0\t500\ttest/core.test.js', 'A\tpad.js\nD\ttest/core.test.js'), /deletes test file/);
  // an explicit deletion goal is allowed
  assert.equal(destructiveDiffReason('remove the dead module', '0\t400\told.js', 'D\told.js'), null);
  // a normal additive change is clean
  assert.equal(destructiveDiffReason('add a feature', '40\t3\tsrc/feature.js', 'A\tsrc/feature.js'), null);
});

test('destructiveDiffReason closes the round-7 High#4 bypasses', () => {
  // root-level test file (test_parser.py) — not in a test/ dir
  assert.match(destructiveDiffReason('make it green', '0\t50\ttest_parser.py', 'D\ttest_parser.py'), /deletes test file/);
  // a deletion WORD present but not the intent ("add X and remove the stub") still catches a test deletion
  assert.match(destructiveDiffReason('add lazy-load and remove the stub', '10\t5\tsrc/x.js\n0\t40\tsrc/core.test.js', 'M\tsrc/x.js\nD\tsrc/core.test.js'), /deletes test file/);
  // deletions SPLIT across files (no single file >100) — aggregate catches it
  assert.match(destructiveDiffReason('fix the build', '0\t60\ta.js\n0\t60\tb.js\n0\t60\tc.js', 'M\ta.js\nM\tb.js\nM\tc.js'), /across files/);
  // EXACTLY 100 net deletions in one file
  assert.match(destructiveDiffReason('fix it', '0\t100\tbig.js', 'M\tbig.js'), /100 net lines/);
  // renaming a test OUT of discovery
  assert.match(destructiveDiffReason('refactor', '0\t0\tx', 'R100\tsrc/core.test.js\tsrc/core.js'), /out of test discovery/);
  // an explicit TEST goal may legitimately remove a test
  assert.equal(destructiveDiffReason('remove the flaky parser test', '0\t40\tsrc/parser.test.js', 'D\tsrc/parser.test.js'), null);
});
