// test/codex.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseCodexStream, runCodex, runAgent } from '../src/engine.mjs';

const FAKE = path.resolve('test/fake-codex.mjs');

test('parseCodexStream takes the last agent_message and token usage', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_configured' }),
    JSON.stringify({ type: 'agent_message', text: 'first' }),
    JSON.stringify({ type: 'agent_message', text: 'final answer' }),
    JSON.stringify({ type: 'token_count', input_tokens: 10, output_tokens: 5 }),
  ].join('\n');
  const p = parseCodexStream(jsonl);
  assert.equal(p.assistantText, 'final answer');
  assert.equal(p.tokens.output_tokens, 5);
});

test('runCodex returns the claude-shaped result so the spine is engine-agnostic', async () => {
  const r = await runCodex({ cwd: process.cwd(), prompt: 'do it', env: { ...process.env, GHOST_FAKE_SCENARIO: 'success' }, bin: FAKE });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result.subtype, 'success');
  assert.match(r.text, /FIXED file/);
  assert.equal(r.usage.input_tokens, 90);
});

test('runCodex marks a crash with NO result so the watcher treats it as errored (re-audit #9)', async () => {
  const r = await runCodex({ cwd: process.cwd(), prompt: 'x', env: { ...process.env, GHOST_FAKE_SCENARIO: 'crash' }, bin: FAKE });
  assert.equal(r.exitCode, 1);
  assert.equal(r.result, null);   // no synthesized result → classifyOutcome → 'errored', not 'stalled'
});

test('runAgent dispatches to codex when engine=codex', async () => {
  const r = await runAgent({ engine: 'codex', cwd: process.cwd(), prompt: 'x', env: { ...process.env, GHOST_FAKE_SCENARIO: 'success' }, bin: FAKE });
  assert.equal(r.result.subtype, 'success');
});
