// test/integration.test.mjs — the built-but-previously-unwired pieces, now enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCard, runNight } from '../src/spine.mjs';
import { Governor } from '../src/governor.mjs';

const baseCard = (over = {}) => ({
  project: 'itg', repoPath: '/tmp/none', goal: 'pass', acceptanceArgv: ['true'],
  acceptanceTimeoutSec: 10, branch: 'ghost/2026-08-21-itg', maxIterations: 3,
  maxTurns: 5, maxBudgetUsd: 1, situation: 'kickoff', ...over,
});

function baseDeps(over = {}) {
  return {
    now: () => Date.parse('2026-08-21T22:00:00Z'),
    makeClone: () => '/tmp/fake', headRef: () => 'BASE', commit: () => {},
    gitDiff: () => ({ stat: ' 1 file changed', excerpt: 'diff' }),
    runEngine: async () => ({ exitCode: 0, result: { subtype: 'success', result: 'done' }, usage: { input_tokens: 200, output_tokens: 100 }, text: 'done' }),
    patchApplied: () => true,
    verify: async () => ({ pass: true, detail: { testOutput: 'ok' } }),
    writeNextPrompt: async () => 'next',
    ...over,
  };
}

test('runCard reports tokensUsed summed from engine usage', async () => {
  const r = await runCard(baseCard(), baseDeps());
  assert.equal(r.tokensUsed, 300);   // 200 + 100 on the one iteration
});

test('runCard records lineage for every prompt it writes', async () => {
  const recorded = [];
  const r = await runCard(baseCard({ maxIterations: 2 }), baseDeps({
    verify: async () => ({ pass: false, detail: { testOutput: 'fail' } }),
    recordPrompt: (e) => recorded.push(e),
  }));
  assert.equal(r.outcome, 'parked');
  assert.ok(recorded.length >= 1, 'at least one prompt was recorded to lineage');
  assert.ok(recorded.every(e => typeof e.iteration === 'number' && typeof e.prompt === 'string'));
});

test('runNight enforces the Governor token cap and stops cleanly mid-queue', async () => {
  const gov = new Governor({ maxTokensNight: 500, nightDeadlineMs: Date.parse('2026-08-21T22:00:00Z') + 3600_000, maxConsecErrors: 5 });
  const cards = [baseCard({ project: 'a', branch: 'ghost/a' }), baseCard({ project: 'b', branch: 'ghost/b' }), baseCard({ project: 'c', branch: 'ghost/c' })];
  const night = await runNight(cards, { ...baseDeps(), governor: gov });
  // each card spends 300 tokens; cap is 500, so after card 1 (300) it's fine, after card 2 (600) it trips
  assert.equal(night.cards.length, 3);                 // 2 ran; the 3rd is REPORTED as skipped, not dropped (round 28 #14)
  assert.equal(night.cards[2].outcome, 'skipped');
  assert.match(night.cards[2].whyLine, /not started/);
  assert.equal(night.tripReason, 'token-budget');
  assert.ok(night.tokens >= 500);
});

test('runNight enforces the night deadline before the next card', async () => {
  const now = Date.parse('2026-08-21T22:00:00Z');
  const gov = new Governor({ maxTokensNight: 1e9, nightDeadlineMs: now - 1, maxConsecErrors: 5 });
  const night = await runNight([baseCard()], { ...baseDeps(), governor: gov });
  assert.equal(night.cards.length, 1);              // deadline already passed → nothing runs, but the card is reported skipped (round 28 #14)
  assert.equal(night.cards[0].outcome, 'skipped');
  assert.equal(night.tripReason, 'night-deadline');
});
