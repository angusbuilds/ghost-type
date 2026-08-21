// test/engine-parse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamJson } from '../src/engine.mjs';

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
