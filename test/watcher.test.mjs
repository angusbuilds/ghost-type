// test/watcher.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome } from '../src/watcher.mjs';

const NOW = Date.parse('2026-08-21T22:00:00Z');

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
