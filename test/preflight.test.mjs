// test/preflight.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidates, voteBest } from '../src/preflight.mjs';

test('generateCandidates returns n non-empty distinct-ish drafts', async () => {
  let call = 0;
  const engine = async () => ({ text: `candidate ${++call}` });
  const cands = await generateCandidates({ context: 'goal: fix parser', n: 3, engine });
  assert.equal(cands.length, 3);
  assert.ok(cands.every(c => c.length > 0));
});

test('voteBest picks the index the judge returns', async () => {
  const engine = async ({ prompt }) => {
    assert.match(prompt, /CANDIDATE/i);   // judge sees the candidates
    return { text: '{"choice": 2, "reason": "most concrete"}' };
  };
  const { choice, index } = await voteBest({ candidates: ['a', 'b', 'c'], context: 'ctx', engine });
  assert.equal(index, 2);
  assert.equal(choice, 'c');
});

test('voteBest falls back to the first candidate on unparseable judge output', async () => {
  const engine = async () => ({ text: 'i have opinions but no json' });
  const { index } = await voteBest({ candidates: ['a', 'b'], context: 'ctx', engine });
  assert.equal(index, 0);
});
