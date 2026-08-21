// test/verifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance, netLinesGutted } from '../src/verifier.mjs';

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
