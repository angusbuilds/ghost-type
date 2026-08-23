// test/preflight.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidates, voteBest } from '../src/preflight.mjs';

test('generateCandidates rejects a structured is_error (rate-limit) result — no limit message becomes a candidate (round 28 #3-variant)', async () => {
  const engine = async () => ({ exitCode: 0, result: { subtype: 'success', is_error: true }, text: "You've hit your usage limit." });
  const cands = await generateCandidates({ context: 'ctx', n: 3, engine });
  assert.deepEqual(cands, []);   // the limit message is NOT a candidate prompt
});

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

test('voteBest NEVER truncates the JSON-format instruction off the tail, so a big context cannot force a silent index-0 vote (round 33 audit)', async () => {
  // The trailing "Answer strictly as JSON: {...}" was appended before byteCap(..., VOTE_CAP) — a large
  // context + candidates truncated the instruction away, so parseChoice found no JSON and every vote
  // silently fell back to candidate 0, wasting the candidate-generation + vote calls.
  let captured = '';
  const engine = async ({ prompt }) => { captured = prompt; return { text: '{"choice": 2, "reason": "best"}' }; };
  const context = 'c'.repeat(39000);
  const candidates = ['a'.repeat(4000), 'b'.repeat(4000), 'the winner'];
  const res = await voteBest({ candidates, context, engine });
  assert.match(captured, /Answer strictly as JSON/, 'the JSON-format instruction must survive the VOTE_CAP');
  assert.equal(res.index, 2, 'the judge\'s real choice is honored, not a truncation-forced fallback to 0');
});
