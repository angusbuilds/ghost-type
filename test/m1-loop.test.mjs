// test/m1-loop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCard } from '../src/spine.mjs';

test('M1: false-done caught on try 1, ships on try 2, ledger + preflight exercised', async () => {
  let engineCalls = 0, candidateCalls = 0, patched = false;
  const card = {
    project: 'm1', repoPath: '/tmp/none', goal: 'make it pass',
    acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, branch: 'ghost/2026-08-21-m1',
    maxIterations: 3, maxTurns: 5, maxBudgetUsd: 1, situation: 'kickoff',
  };
  const deps = {
    now: () => Date.parse('2026-08-21T22:00:00Z'),
    makeClone: () => '/tmp/fake', headRef: () => 'BASE',
    commit: () => {},
    gitDiff: () => ({ stat: ' 1 file changed', excerpt: 'diff' }),
    runEngine: async () => { engineCalls++; if (engineCalls === 2) patched = true; return { exitCode: 0, result: { subtype: 'success', result: 'all tests pass, done!' }, usage: {}, text: 'all tests pass, done!' }; },
    patchApplied: () => patched,               // false on try 1, true on try 2
    verify: async () => ({ pass: patched, detail: { testOutput: patched ? 'ok' : 'AssertionError' } }),
    classifyClaim: ({ claimText, verifyPass }) => ({ claimedDone: /done/.test(claimText), falseDone: /done/.test(claimText) && !verifyPass }),
    diagnoseFailure: async () => 'the patch was never written',
    generateCandidates: async () => { candidateCalls++; return ['try writing the file', 'revert then retry']; },
    voteBest: async ({ candidates }) => ({ choice: candidates[0], index: 0 }),
    writeNextPrompt: async () => 'fallback prompt',
  };
  const r = await runCard(card, deps);
  assert.equal(r.outcome, 'shipped');
  assert.ok(r.falseDoneCount >= 1, 'a false-done was recorded');
  assert.ok(candidateCalls >= 1, 'preflight candidate generation ran');
  assert.ok(r.ledger.length >= 1, 'the attempt ledger accumulated rows');
});
