// test/engine-parse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamJson, capped, runEngine, runCodex } from '../src/engine.mjs';

test('capped keeps a small stream whole', () => {
  const c = capped(1000);
  c.push('line one\n'); c.push('line two\n');
  assert.equal(c.get(), 'line one\nline two\n');
});

test('capped preserves the FINAL event past the budget via a rolling tail (round 6 #6)', () => {
  const c = capped(1000);   // 500-byte head + 500-byte tail
  c.push('x'.repeat(600));                                   // fills the head, flips to tail mode
  for (let i = 0; i < 50; i++) c.push('filler-'.repeat(20)); // lots of middle content
  c.push('\n{"type":"result","total_cost_usd":0.42}');       // the terminal accounting event, last
  const out = c.get();
  // bounded well under the ~7.6KB actually pushed (head ≤ half + one chunk, tail ≤ half)
  assert.ok(out.length < 2000, `bounded: ${out.length}`);
  // the parser must still find the final result event (it lives in the retained tail)
  const parsed = parseStreamJson(out);
  assert.equal(parsed.result?.total_cost_usd, 0.42);
});

const NDJSON = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 }),
].join('\n');

test('extracts result, usage, and assistant text', () => {
  const p = parseStreamJson(NDJSON);
  assert.equal(p.result.subtype, 'success');
  assert.equal(p.usage.output_tokens, 5);
  assert.match(p.assistantText, /working on it/);
});

test('tolerates a trailing blank line and a malformed line', () => {
  const p = parseStreamJson(NDJSON + '\n\nnot json\n');
  assert.ok(p.result);          // still found the good result
  assert.equal(p.events.length >= 3, true);
});

test('runEngine/runCodex resolve a structured failure when spawn throws synchronously — never reject (round 31 engine audit #2)', async () => {
  // A non-string bin makes spawn() throw synchronously inside the Promise executor. The contract is
  // to always resolve { exitCode, result } so engineFailed/classifyOutcome see a failure, never an
  // unhandled rejection.
  for (const fn of [runEngine, runCodex]) {
    const r = await fn({ cwd: '/tmp', prompt: 'x', allowedTools: 'Read', maxBudgetUsd: 1, bin: 12345 });
    assert.equal(r.exitCode, 1);
    assert.equal(r.result, null);
    assert.match(String(r.text), /spawn/i);
  }
});

test('capped bounds the TAIL by bytes, not code units, and preserves the final event (round 31 engine audit #3)', () => {
  const c = capped(1000);   // 500-byte head + 500-byte tail budget
  c.push('H'.repeat(600));  // fill the head past 500 bytes
  c.push('あ'.repeat(2000)); // 2000 multibyte chars = 6000 bytes; the OLD .length cap kept ~500 chars = ~1500 bytes
  c.push('\n{"type":"result","usage":{"input_tokens":7}}');   // the terminal event at the very end
  const out = c.get();
  // the byte-bounded tail keeps ≤500 bytes; without the fix it kept 500 あ = 1500 bytes (total ~2100).
  // (the head can overshoot by one push — pre-existing — so allow slack, but far below the unfixed size.)
  assert.ok(Buffer.byteLength(out) <= 1200, `capture ${Buffer.byteLength(out)} bytes — the tail isn't byte-bounded`);
  assert.match(out, /"input_tokens":7/);   // the final usage event survived the byte-trim
});
