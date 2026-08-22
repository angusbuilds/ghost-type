// test/governor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Governor, usageTokens } from '../src/governor.mjs';

const NOW = Date.parse('2026-08-21T22:00:00Z');

test('a null nightDeadlineMs means NO deadline — check() does not trip immediately (round 29)', () => {
  const g = new Governor({ maxTokensNight: 1e9, nightDeadlineMs: null, maxConsecErrors: 5 });
  assert.deepEqual(g.check(NOW), { ok: true, trip: null });   // was: `NOW >= null` → tripped night-deadline
  assert.equal(g.remainingMs(NOW), Infinity);                 // consistent with remainingMs
});

test('usageTokens sums ALL four buckets incl. cache, so the token cap counts a cached call correctly (round 28 #7)', () => {
  const usage = { input_tokens: 33, cache_creation_input_tokens: 53995, cache_read_input_tokens: 230827, output_tokens: 904 };
  assert.equal(usageTokens(usage), 285759);              // not 937 (input+output only) — a ~300x undercount before
  assert.equal(usageTokens({ input_tokens: 10, output_tokens: 5 }), 15);   // no cache fields → just input+output
  assert.equal(usageTokens(null), 0);
  const g = new Governor({ maxTokensNight: 300000, nightDeadlineMs: NOW + 3600_000, maxConsecErrors: 5 });
  g.addUsage(usage);
  assert.equal(g.tokens, 285759);                        // the cap now meters the real usage
});
const caps = { maxTokensNight: 1000, nightDeadlineMs: NOW + 3600_000, maxConsecErrors: 3 };

test('trips on token budget', () => {
  const g = new Governor(caps);
  g.addUsage({ input_tokens: 600, output_tokens: 500 });
  assert.deepEqual(g.check(NOW), { ok: false, trip: 'token-budget' });
});

test('trips on the dollar budget', () => {
  const g = new Governor({ ...caps, maxCostUsd: 5 });
  g.addCost(3); g.addCost(2.5);
  assert.deepEqual(g.check(NOW), { ok: false, trip: 'cost-budget' });
});

test('no dollar cap by default (Infinity) never trips on cost', () => {
  const g = new Governor(caps);
  g.addCost(1000);
  assert.equal(g.check(NOW).ok, true);
});

test('trips on night deadline', () => {
  const g = new Governor(caps);
  assert.deepEqual(g.check(NOW + 3600_001), { ok: false, trip: 'night-deadline' });
});

test('trips after N consecutive errors, resets on ok', () => {
  const g = new Governor(caps);
  g.noteError(); g.noteError(); g.noteOk(); g.noteError(); g.noteError();
  assert.equal(g.check(NOW).ok, true);      // only 2 in a row after the ok
  g.noteError();
  assert.deepEqual(g.check(NOW), { ok: false, trip: 'consecutive-errors' });
});

test('ok when under all caps', () => {
  const g = new Governor(caps);
  g.addUsage({ input_tokens: 100, output_tokens: 100 });
  assert.deepEqual(g.check(NOW), { ok: true, trip: null });
});

test('remainingUsd/remainingMs report headroom for per-call bounding (round 6 #8)', () => {
  const g = new Governor({ ...caps, maxCostUsd: 10 });
  g.addCost(9.99);
  assert.ok(Math.abs(g.remainingUsd() - 0.01) < 1e-9);   // a call may spend at most ~$0.01 more
  assert.equal(g.remainingMs(NOW), 3600_000);            // one hour to the deadline
  assert.equal(g.remainingMs(NOW + 3600_000 + 5), 0);    // never negative past the deadline
});

test('remainingUsd is Infinity when no dollar cap is set (round 6 #8)', () => {
  const g = new Governor(caps);   // no maxCostUsd → Infinity
  assert.equal(g.remainingUsd(), Infinity);
});
