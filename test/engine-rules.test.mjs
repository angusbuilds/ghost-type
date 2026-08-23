// test/engine-rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeForEngine } from '../src/engine-rules.mjs';
import { validateCard } from '../src/card.mjs';

const card = { acceptanceArgv: ['npm', 'test'] };

test('claude prompts are left as the loose directive', () => {
  assert.equal(shapeForEngine('make the gallery lazy-load', 'claude', card), 'make the gallery lazy-load');
});

test('codex prompts get an explicit ordered tail with the real test command', () => {
  const out = shapeForEngine('make the gallery lazy-load', 'codex', card);
  assert.match(out, /make the gallery lazy-load/);
  assert.match(out, /step by step/);
  assert.match(out, /run: npm test/);
  assert.match(out, /exits 0/);
  assert.match(out, /dont touch anything outside this repo/);
});

test('card validates the engine field', () => {
  const good = { project: 'p', repoPath: '/r', goal: 'g', branch: 'ghost/x', acceptanceArgv: ['true'] };
  assert.equal(validateCard(good).engine, 'claude');            // default
  assert.equal(validateCard({ ...good, engine: 'codex' }).engine, 'codex');
  assert.throws(() => validateCard({ ...good, engine: 'gpt' }), /engine/);
});

test('shapeForEngine falls back to the goal when the next-prompt is blank, so codex is not handed a goal-less instruction (round 35)', () => {
  const card = { acceptanceArgv: ['npm', 'test'], goal: 'make the gallery lazy-load' };
  // a successful-but-empty writer call passes through '' as the next prompt (round 28 #3-variant)
  const codex = shapeForEngine('', 'codex', card);
  assert.match(codex, /make the gallery lazy-load/);        // the goal, not a directionless "make the changes" tail
  const blankClaude = shapeForEngine('   ', 'claude', card);
  assert.equal(blankClaude, 'make the gallery lazy-load');   // blank → goal
  assert.equal(shapeForEngine('do the thing', 'claude', card), 'do the thing');   // a real prompt is unchanged
});
