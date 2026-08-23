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

test('parses an absolute "try again at 6:00 PM" as the NEXT local occurrence (round 28 #5)', () => {
  const now = new Date(2026, 7, 21, 22, 0, 0).getTime();       // 10:00 PM local (month 7 = Aug)
  const at = parseResetTime('usage limit. try again at 6:00 PM.', now);
  assert.equal(at, new Date(2026, 7, 22, 18, 0, 0).getTime()); // 6 PM the NEXT day — 6pm today is already past
});

test('parses "resets at 11:30pm" as later today (round 28 #5)', () => {
  const now = new Date(2026, 7, 21, 22, 0, 0).getTime();       // 10 PM local
  const at = parseResetTime('rate limit, resets at 11:30pm', now);
  assert.equal(at, new Date(2026, 7, 21, 23, 30, 0).getTime()); // 11:30 PM today
});

test('parseResetTime anchors to the trigger — unrelated durations/clocks elsewhere are ignored (round 32 audit)', () => {
  // (1) a duration BEFORE the trigger must not be summed into the reset
  const r1 = parseResetTime('spent 45m debugging, then ran the build for 10s. usage limit reached, try again in 30m.', NOW);
  assert.equal(r1, NOW + 30 * 60_000);   // +30m only, not +75m10s
  // (2) an earlier "at H:MM" must not be mistaken for the reset clock
  const tenPm = Date.parse('2026-08-22T22:00:00');   // local 10pm
  const r2 = parseResetTime('started the run at 9:15, then hit the usage limit; resets at 6:00 PM.', tenPm);
  const d = new Date(r2);
  assert.equal(d.getHours(), 18);   // 6 PM (the real reset), NOT 9:15
  assert.equal(d.getMinutes(), 0);
});
