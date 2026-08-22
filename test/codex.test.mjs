// test/codex.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseCodexStream, runCodex, runAgent, codexArgs } from '../src/engine.mjs';
import { classifyOutcome } from '../src/watcher.mjs';

test('a Codex turn.failed usage limit is a STRUCTURED error → classified rate-limited, not generic errored (round 28 #4)', async () => {
  const FAKE0 = path.resolve('test/fake-codex.mjs');
  const r = await runCodex({ cwd: process.cwd(), prompt: 'x', env: { ...process.env, GHOST_FAKE_SCENARIO: 'usage-limit' }, bin: FAKE0 });
  assert.notEqual(r.result, null);                    // NOT null — a structured provider failure, not a transport crash
  assert.equal(r.result.is_error, true);
  assert.match(r.text, /usage limit/i);
  // the whole point: the watcher now waits for the reset instead of retrying+parking as 'errored'
  const outcome = classifyOutcome({ exitCode: r.exitCode, result: r.result, text: r.text, nowMs: 0 });
  assert.equal(outcome.state, 'rate-limited');
});

test('codexArgs uses danger-full-access only for CODING calls under the OS sandbox (round 13)', () => {
  const mode = (a) => a[a.indexOf('--sandbox') + 1];
  // no OS sandbox → codex uses its own workspace-write confinement
  assert.equal(mode(codexArgs({ cwd: '/c', prompt: 'p' })), 'workspace-write');
  // CODING call + OS write-confine → codex must NOT double-sandbox (nested Seatbelt silently fails to write)
  assert.equal(mode(codexArgs({ cwd: '/c', prompt: 'p', sandbox: 'workspace-write', sandboxClone: '/c' })), 'danger-full-access');
  // READ-ONLY writer call + OS sandbox → keeps codex's own read-only sandbox (not OS-wrapped, invariant preserved)
  assert.equal(mode(codexArgs({ cwd: '/c', prompt: 'p', sandbox: 'read-only', sandboxClone: '/c' })), 'read-only');
});

const FAKE = path.resolve('test/fake-codex.mjs');

test('parseCodexStream reads the CURRENT codex schema: item.completed text + turn.completed usage (round 8)', () => {
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 't' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'error', message: 'a warning' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'final answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join('\n');
  const p = parseCodexStream(jsonl);
  assert.equal(p.assistantText, 'final answer');   // nested item.completed text, not top-level
  assert.equal(p.tokens.output_tokens, 5);          // turn.completed.usage
  assert.equal(p.errorMsg, 'a warning');
});

test('a coding turn with NO agent_message but turn.completed is success, not error (round 11)', () => {
  // codex often does the work via tool calls and emits only a benign item error (skill warning)
  // + turn.completed — success must not depend on an assistant_message being present.
  const jsonl = [
    JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'error', message: 'skill descriptions were shortened' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5 } }),
  ].join('\n');
  const p = parseCodexStream(jsonl);
  assert.equal(p.turnCompleted, true);
  assert.equal(p.turnFailed, false);
  assert.equal(p.assistantText, '');   // no agent_message — old logic would have called this 'error'
});

test('a turn.failed event marks the codex turn as failed (round 11)', () => {
  const p = parseCodexStream(JSON.stringify({ type: 'turn.failed', error: { message: 'model refused' } }));
  assert.equal(p.turnFailed, true);
  assert.match(p.errorMsg, /model refused/);
});

test('parseCodexStream still reads the LEGACY top-level shape (backward compat)', () => {
  const jsonl = [
    JSON.stringify({ type: 'agent_message', text: 'legacy answer' }),
    JSON.stringify({ type: 'token_count', input_tokens: 3, output_tokens: 2 }),
  ].join('\n');
  const p = parseCodexStream(jsonl);
  assert.equal(p.assistantText, 'legacy answer');
  assert.equal(p.tokens.output_tokens, 2);
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

test('an exit-0 turn with NO turn.completed is NOT success — forced to errored (round 12)', async () => {
  const r = await runCodex({ cwd: process.cwd(), prompt: 'x', env: { ...process.env, GHOST_FAKE_SCENARIO: 'no-events' }, bin: FAKE });
  assert.equal(r.result, null);      // truncated/invalid turn → no synthesized success
  assert.notEqual(r.exitCode, 0);    // forced nonzero so the watcher classifies it 'errored', not 'stalled'
});

test('a stall (turn.completed but did not fix it) IS a completed turn → success, graded by verify (round 12)', async () => {
  const r = await runCodex({ cwd: process.cwd(), prompt: 'x', env: { ...process.env, GHOST_FAKE_SCENARIO: 'stall' }, bin: FAKE });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result.subtype, 'success');   // the turn completed; the acceptance test is what fails it
});

test('runAgent dispatches to codex when engine=codex', async () => {
  const r = await runAgent({ engine: 'codex', cwd: process.cwd(), prompt: 'x', env: { ...process.env, GHOST_FAKE_SCENARIO: 'success' }, bin: FAKE });
  assert.equal(r.result.subtype, 'success');
});
