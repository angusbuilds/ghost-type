// test/governor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Governor } from '../src/governor.mjs';

const NOW = Date.parse('2026-08-21T22:00:00Z');
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
