// test/watcher.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome } from '../src/watcher.mjs';

const NOW = Date.parse('2026-08-21T22:00:00Z');

test('a subtype:success result FLAGGED is_error is NOT done — Claude reports billing/limit failures that way (round 28 #3)', () => {
  // a plain limit message that isn't the RATE keyword shape → a real error, not a false "done" or a stall
  assert.equal(classifyOutcome({ exitCode: 0, result: { subtype: 'success', is_error: true, result: "You've hit your limit" }, nowMs: NOW }).state, 'errored');
  // the same shape carrying a canonical usage-limit phrase → rate-limited (waits for reset), still not done
  assert.equal(classifyOutcome({ exitCode: 0, result: { subtype: 'success', is_error: true, result: 'You have hit your usage limit, try again in 30 minutes' }, nowMs: NOW }).state, 'rate-limited');
  // a genuine success (no is_error) is still done, even if it MENTIONS a limit
  assert.equal(classifyOutcome({ exitCode: 0, result: { subtype: 'success', result: 'fixed the rate limit bug' }, nowMs: NOW }).state, 'done');
});

test('success result → done', () => {
  const o = classifyOutcome({ exitCode: 0, result: { subtype: 'success', result: 'ok' }, text: 'ok', nowMs: NOW });
  assert.equal(o.state, 'done');
});

test('rate-limit message → rate-limited with resetAtMs', () => {
  const o = classifyOutcome({ exitCode: 0, result: { subtype: 'error', result: 'usage limit reached, resets in 1h' }, text: 'usage limit reached, resets in 1h', nowMs: NOW });
  assert.equal(o.state, 'rate-limited');
  assert.equal(o.resetAtMs, NOW + 3600 * 1000);
});

test('network error text + nonzero exit → network', () => {
  const o = classifyOutcome({ exitCode: 1, result: null, text: 'fetch failed: ENOTFOUND api.anthropic.com', nowMs: NOW });
  assert.equal(o.state, 'network');
});

test('generic error → stalled', () => {
  const o = classifyOutcome({ exitCode: 0, result: { subtype: 'error', result: 'could not resolve the failure' }, text: 'could not resolve the failure', nowMs: NOW });
  assert.equal(o.state, 'stalled');
});

test('a SUCCESS that merely mentions a rate limit is still done (H4)', () => {
  const o = classifyOutcome({ exitCode: 0, result: { subtype: 'success', result: 'fixed the rate limit handling, tests pass' }, text: 'fixed the rate limit handling', nowMs: NOW });
  assert.equal(o.state, 'done');
});

test('a nonzero exit with no result and no network text is errored, not network (M4)', () => {
  const o = classifyOutcome({ exitCode: 127, result: null, text: 'command not found: claude', nowMs: NOW });
  assert.equal(o.state, 'errored');
});

test('a bare "resets in" without a limit keyword is NOT a rate-limit (round 5 #4)', () => {
  const o = classifyOutcome({ exitCode: 0, result: { subtype: 'error', result: 'cache entry resets in 60s' }, text: 'cache entry resets in 60s', nowMs: NOW });
  assert.equal(o.state, 'stalled');   // not rate-limited — no usage/rate/quota/limit nearby
});

test('a crash mentioning "rate limit" is transport-errored, not rate-limited (round 5 L2)', () => {
  const o = classifyOutcome({ exitCode: 1, result: null, text: 'Error: implemented rate limit handling but crashed', nowMs: NOW });
  assert.equal(o.state, 'errored');   // nonzero + no result → transport, decided before rate text
});
