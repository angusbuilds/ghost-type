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

test('voteBest survives trailing prose after the JSON object (round 5 #8)', async () => {
  const engine = async () => ({ text: '{"choice": 1, "reason": "clear"}\n\nI picked it because {it is best}.' });
  const { index, choice } = await voteBest({ candidates: ['a', 'b', 'c'], context: 'ctx', engine });
  assert.equal(index, 1);       // greedy match would have swallowed the trailing "}" and voted 0
  assert.equal(choice, 'b');
});

test('a transport-failed writer call is NOT used as a candidate or a vote (round 5 M5)', async () => {
  const failing = async () => ({ exitCode: 1, result: null, text: 'network unreachable after retries' });
  const cands = await generateCandidates({ context: 'g', n: 3, engine: failing });
  assert.deepEqual(cands, []);   // the error string never becomes a candidate
  const { index } = await voteBest({ candidates: ['a', 'b'], context: 'ctx', engine: failing });
  assert.equal(index, 0);        // a failed vote falls back, doesn't parse the error text
});
