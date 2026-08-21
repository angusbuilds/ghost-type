// test/verifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance, netLinesGutted, patchApplied, classifyClaim } from '../src/verifier.mjs';
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

test('netLinesGutted flags a net-negative diff', () => {
  assert.equal(netLinesGutted(' 3 files changed, 2 insertions(+), 40 deletions(-)'), true);
  assert.equal(netLinesGutted(' 3 files changed, 40 insertions(+), 2 deletions(-)'), false);
});
