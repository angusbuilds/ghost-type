// test/engine-parse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamJson, capped } from '../src/engine.mjs';

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
