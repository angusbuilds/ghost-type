// test/engine-run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runEngine } from '../src/engine.mjs';

const FAKE = path.resolve('test/fake-claude.mjs');

test('runEngine drives the fake success scenario and parses its result', async () => {
  const r = await runEngine({
    cwd: process.cwd(), prompt: 'do the thing',
    allowedTools: 'Read', maxTurns: 5, maxBudgetUsd: 1,
    env: { ...process.env, GHOST_FAKE_SCENARIO: 'success' }, bin: FAKE,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result.subtype, 'success');
  assert.equal(r.usage.output_tokens, 50);
  assert.match(r.text, /implemented the fix/);
});

test('runEngine surfaces a nonzero exit (network scenario)', async () => {
  const r = await runEngine({
    cwd: process.cwd(), prompt: 'x', allowedTools: 'Read', maxTurns: 5, maxBudgetUsd: 1,
    env: { ...process.env, GHOST_FAKE_SCENARIO: 'network' }, bin: FAKE,
  });
  assert.equal(r.exitCode, 1);
});
