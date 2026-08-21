// test/reset-time.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime } from '../src/reset-time.mjs';

const NOW = Date.parse('2026-08-21T22:00:00Z');

test('parses a relative "resets in 2h 30m"', () => {
  const at = parseResetTime('usage limit reached, resets in 2h 30m', NOW);
  assert.equal(at, NOW + (2 * 60 + 30) * 60 * 1000);
});

test('parses "try again in 45 minutes"', () => {
  const at = parseResetTime('rate limit hit. try again in 45 minutes.', NOW);
  assert.equal(at, NOW + 45 * 60 * 1000);
});

test('returns null when no reset info present', () => {
  assert.equal(parseResetTime('some unrelated error', NOW), null);
});
