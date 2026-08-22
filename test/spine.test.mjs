// test/spine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCard, runCardSafely, runNight } from '../src/spine.mjs';
import { Governor } from '../src/governor.mjs';

const card = {
  project: 'demo', repoPath: '/tmp/none', goal: 'pass the test',
  acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, branch: 'ghost/2026-08-21-demo',
  maxIterations: 3, maxTurns: 5, maxBudgetUsd: 1, situation: 'kickoff',
};

function deps(overrides = {}) {
  return {
    now: () => Date.parse('2026-08-21T22:00:00Z'),
    makeClone: () => '/tmp/fake-clone',
    commit: () => {},
    gitDiff: () => ({ stat: ' 1 file changed, 5 insertions(+)', excerpt: 'diff' }),
    runEngine: async () => ({ exitCode: 0, result: { subtype: 'success', result: 'done' }, usage: { input_tokens: 10, output_tokens: 5 }, text: 'done' }),
    verify: async () => ({ pass: true, detail: { testOutput: 'ok' } }),
    writeNextPrompt: async () => 'keep going',
    ...overrides,
  };
}

test('a card that verifies on iteration 1 ships', async () => {
  const r = await runCard(card, deps());
  assert.equal(r.outcome, 'shipped');
  assert.equal(r.mergeReady, true);
  assert.equal(r.iterations, 1);
});

test('a rate-limit whose reset is PAST the nightly deadline parks immediately, not sleeping for hours (round 28 #5)', async () => {
  const NOW = Date.parse('2026-08-21T22:00:00Z');
  const gov = new Governor({ maxTokensNight: 1e9, maxCostUsd: 1e9, nightDeadlineMs: NOW + 3600_000, maxConsecErrors: 5 });   // 1h deadline
  let slept = false;
  const r = await runCard(card, deps({
    now: () => NOW,
    runEngine: async () => ({ exitCode: 0, result: { subtype: 'error', result: 'usage limit reached, try again in 10h' }, usage: { input_tokens: 1, output_tokens: 1 }, text: '' }),
    sleepUntil: async () => { slept = true; },
    governor: gov,
  }));
  assert.equal(r.outcome, 'parked');
  assert.match(r.whyLine, /past the nightly deadline/);
  assert.equal(slept, false);                          // reset is 10h out but the night ends in 1h → don't wait
});

test('failing acceptance tests do NOT trip the consecutive-error breaker — the card uses its full iteration budget (round 28 #6)', async () => {
  const NOW = Date.parse('2026-08-21T22:00:00Z');
  const gov = new Governor({ maxTokensNight: 1e9, maxCostUsd: 1e9, nightDeadlineMs: NOW + 3600_000, maxConsecErrors: 3 });
  const r = await runCard({ ...card, maxIterations: 5 }, deps({
    now: () => NOW,
    verify: async () => ({ pass: false, detail: { testOutput: 'still failing' } }),
    writeNextPrompt: async () => 'try again',
    governor: gov,
  }));
  assert.equal(r.outcome, 'parked');
  assert.equal(r.iterations, 5);                       // ran all 5 — not stopped at maxConsecErrors=3
  assert.match(r.whyLine, /no pass after 5/);          // parked on the ITERATION budget, not governor: consecutive-errors
});

test('runCardSafely PARKS a card whose runCard throws (clone/commit/unborn-HEAD) rather than aborting the night (round 18 #10)', async () => {
  const r = await runCardSafely(card, deps({ makeClone: () => { throw new Error('fatal: clone failed — disk full\n(second line ignored)'); } }));
  assert.equal(r.outcome, 'parked');                 // counts in the report's parked tally, doesn't vanish
  assert.equal(r.mergeReady, false);
  assert.match(r.whyLine, /errored and was parked/);
  assert.match(r.whyLine, /disk full/);
  assert.doesNotMatch(r.whyLine, /second line/);     // whyLine is the first line only
  assert.equal(r.branch, card.branch);               // still identifiable in the morning report
  assert.deepEqual(r.promptsWritten, []);
});

test('runCardSafely passes a NON-throwing runCard result through unchanged (round 18 #10)', async () => {
  const r = await runCardSafely(card, deps());       // ships normally — wrapper is transparent on success
  assert.equal(r.outcome, 'shipped');
  assert.equal(r.mergeReady, true);
  assert.equal(r.iterations, 1);
});

test('runNight reports the GOVERNOR cost even when a card throws AFTER its engine call was metered (round 19 A4)', async () => {
  const NOW = Date.parse('2026-08-21T22:00:00Z');
  const gov = new Governor({ maxTokensNight: 1e9, maxCostUsd: 100, nightDeadlineMs: NOW + 3600_000, maxConsecErrors: 9 });
  const d = deps({
    now: () => NOW,
    runEngine: async () => ({ exitCode: 0, result: { subtype: 'success', result: 'done', total_cost_usd: 0.25 }, usage: { input_tokens: 10, output_tokens: 5 }, text: 'done' }),
    verify: async () => { throw new Error('verify blew up AFTER the engine call was already metered'); },
    governor: gov,
  });
  const night = await runNight([card], d);
  assert.equal(night.cards[0].outcome, 'parked');    // the throw parked the card...
  assert.ok(night.costUsd >= 0.25);                  // ...but the $0.25 already metered is NOT dropped from the night total
});

test('runNight WITHOUT a governor still reports cost metered before a card threw (round 20 #5)', async () => {
  const d = deps({
    now: () => Date.parse('2026-08-21T22:00:00Z'),
    runEngine: async () => ({ exitCode: 0, result: { subtype: 'success', result: 'done', total_cost_usd: 0.25 }, usage: { input_tokens: 10, output_tokens: 5 }, text: 'done' }),
    verify: async () => { throw new Error('verify blew up after metering'); },
    // NO governor — the metered spend must still be recovered via the cost sink
  });
  const night = await runNight([card], d);
  assert.equal(night.cards[0].outcome, 'parked');
  assert.ok(night.cards[0].costUsd >= 0.25);         // the parked card carries its pre-throw spend...
  assert.ok(night.costUsd >= 0.25);                  // ...and the night total (summed, no governor) isn't zero
});

test('the engine call is bounded to remaining $ AND the 45-min ceiling, not the full budget/deadline (round 7 H3)', async () => {
  const seen = [];
  const NOW = Date.parse('2026-08-21T22:00:00Z');
  const gov = new Governor({ maxTokensNight: 1e9, maxCostUsd: 0.3, nightDeadlineMs: NOW + 2 * 3600_000, maxConsecErrors: 9 });
  await runCard(card, deps({
    now: () => NOW, governor: gov,
    runEngine: async (opts) => { seen.push(opts); return { exitCode: 0, result: { subtype: 'success', result: 'done' }, usage: {}, text: 'done' }; },
  }));
  assert.equal(seen[0].maxBudgetUsd, 0.3);          // min(card $1, remaining $0.3) — not the full $1
  assert.equal(seen[0].timeoutMs, 45 * 60 * 1000);  // min(45min, 2h to deadline) — the ceiling, not 2h (the H3 bug)
});

test('the card parks (never verifies past the deadline with a 1s-floored test) (round 9 Low)', async () => {
  let verified = 0;
  const NOW = Date.parse('2026-08-21T22:00:00Z');
  let t = NOW;
  const gov = new Governor({ maxTokensNight: 1e9, maxCostUsd: 100, nightDeadlineMs: NOW + 1000, maxConsecErrors: 9 });   // 1s to deadline
  const r = await runCard(card, deps({
    now: () => t, governor: gov,
    runEngine: async () => { t = NOW + 2000; return { exitCode: 0, result: { subtype: 'success', result: 'done' }, usage: {}, text: 'done' }; },   // the call crosses the deadline
    verify: async () => { verified += 1; return { pass: true, detail: { testOutput: 'ok' } }; },
  }));
  assert.equal(r.outcome, 'parked');
  assert.match(r.whyLine, /night-deadline/);
  assert.equal(verified, 0);   // deadline passed mid-call → parked before running the test, not a 1s-floored run
});

test('the card parks without spending when too little dollar headroom remains (round 7 H3)', async () => {
  let calls = 0;
  const NOW = Date.parse('2026-08-21T22:00:00Z');
  const gov = new Governor({ maxTokensNight: 1e9, maxCostUsd: 0.03, nightDeadlineMs: NOW + 3600_000, maxConsecErrors: 9 });
  const r = await runCard(card, deps({
    now: () => NOW, governor: gov,
    runEngine: async () => { calls += 1; return { exitCode: 0, result: { subtype: 'success', result: 'done' }, usage: {}, text: 'done' }; },
  }));
  assert.equal(r.outcome, 'parked');
  assert.match(r.whyLine, /cost-budget/);
  assert.equal(calls, 0);   // never made a call it couldn't afford (no rounding up to $0.01)
});

test('runCard reports the real dollar cost from the engine result', async () => {
  const r = await runCard(card, deps({
    runEngine: async () => ({ exitCode: 0, result: { subtype: 'success', result: 'done', total_cost_usd: 0.023 }, usage: { input_tokens: 10, output_tokens: 5 }, text: 'done' }),
  }));
  assert.equal(r.costUsd, 0.023);
});

test('a card that never verifies parks after maxIterations', async () => {
  const r = await runCard(card, deps({ verify: async () => ({ pass: false, detail: { testOutput: 'fail' } }) }));
  assert.equal(r.outcome, 'parked');
  assert.equal(r.mergeReady, false);
  assert.equal(r.iterations, 3);
  assert.ok(r.promptsWritten.length >= 1);        // wrote next-prompts between tries
});

test('a rate-limited engine result does not burn an iteration as a failure', async () => {
  let calls = 0;
  const r = await runCard(card, deps({
    runEngine: async () => {
      calls += 1;
      if (calls === 1) return { exitCode: 0, result: { subtype: 'error', result: 'usage limit reached, resets in 1h' }, usage: {}, text: 'usage limit reached, resets in 1h' };
      return { exitCode: 0, result: { subtype: 'success', result: 'done' }, usage: {}, text: 'done' };
    },
    sleepUntil: async () => {},   // don't actually sleep in tests
  }));
  assert.equal(r.outcome, 'shipped');
});

// --- M1 ---

test('M1: a no-op patch fails fast without a false ship', async () => {
  const r = await runCard({ ...card, maxIterations: 1 }, deps({
    patchApplied: () => false,               // agent changed nothing
    verify: async () => ({ pass: true, detail: { testOutput: 'ok' } }), // even if verify would pass
  }));
  assert.equal(r.outcome, 'parked');
  assert.match(r.whyLine, /no.?patch|unchanged/i);
});

test('M1: records a false-done when the agent claims done but verify fails', async () => {
  const r = await runCard({ ...card, maxIterations: 1 }, deps({
    patchApplied: () => true,
    runEngine: async () => ({ exitCode: 0, result: { subtype: 'success', result: 'all tests pass, done!' }, usage: {}, text: 'all tests pass, done!' }),
    verify: async () => ({ pass: false, detail: { testOutput: 'AssertionError' } }),
    classifyClaim: ({ claimText, verifyPass }) => ({ claimedDone: /done/.test(claimText), falseDone: /done/.test(claimText) && !verifyPass }),
  }));
  assert.ok(r.falseDoneCount >= 1);
});
