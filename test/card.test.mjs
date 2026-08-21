// test/card.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCard } from '../src/card.mjs';

const good = {
  project: 'demo', repoPath: '/tmp/demo', goal: 'make the test pass',
  acceptanceArgv: ['node', '--test'], acceptanceTimeoutSec: 120,
  branch: 'ghost/2026-08-21-demo', maxIterations: 3,
  maxTurns: 20, maxBudgetUsd: 2, situation: 'kickoff'
};

test('accepts a well-formed card and fills defaults', () => {
  const c = validateCard({ ...good });
  assert.equal(c.project, 'demo');
  assert.equal(c.maxIterations, 3);
});

test('rejects a shell-string acceptance command', () => {
  assert.throws(() => validateCard({ ...good, acceptanceArgv: 'node --test' }), /acceptanceArgv/);
});

test('rejects a missing goal', () => {
  const bad = { ...good }; delete bad.goal;
  assert.throws(() => validateCard(bad), /goal/);
});

test('rejects a branch name that is not under ghost/', () => {
  assert.throws(() => validateCard({ ...good, branch: 'main' }), /branch/);
});
