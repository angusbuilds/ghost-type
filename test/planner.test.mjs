// test/planner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCards, isCodingCard, branchName, slugify } from '../src/planner.mjs';

const dossiers = [
  { name: 'sitecraft', repoPath: '/d/sitecraft', testRunner: ['npm', 'test'] },
  { name: 'notes', repoPath: '/d/notes', testRunner: null },
];

test('a runner-having repo becomes a valid coding card', () => {
  const { cards } = planCards({ sendoff: 'make the gallery lazy-load', dossiers: [dossiers[0]], dateStr: '2026-08-21' });
  assert.equal(cards.length, 1);
  assert.equal(isCodingCard(cards[0]), true);
  assert.deepEqual(cards[0].acceptanceArgv, ['npm', 'test']);
  assert.match(cards[0].branch, /^ghost\/2026-08-21-sitecraft-/);
});

test('a runnerless repo becomes a proposal-only card', () => {
  const { cards } = planCards({ sendoff: 'tidy up', dossiers: [dossiers[1]], dateStr: '2026-08-21' });
  assert.equal(cards[0].kind, 'proposal');
  assert.equal(isCodingCard(cards[0]), false);
});

test('review backpressure pauses a project over the threshold', () => {
  const { cards, paused } = planCards({ sendoff: 'x', dossiers: [dossiers[0]], dateStr: '2026-08-21', unmergedByProject: { sitecraft: 3 }, backpressureThreshold: 3 });
  assert.equal(cards.length, 0);
  assert.deepEqual(paused, ['sitecraft']);
});

test('maxCards caps the queue', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, repoPath: `/d/p${i}`, testRunner: ['npm', 'test'] }));
  const { cards } = planCards({ sendoff: 'go', dossiers: many, dateStr: '2026-08-21', maxCards: 2 });
  assert.equal(cards.length, 2);
});

test('slugify + branchName produce clean branch names', () => {
  assert.equal(slugify('Make the Gallery!! lazy-load'), 'make-the-gallery-lazy-load');
  assert.match(branchName('site', '2026-08-21', 'fix bug'), /^ghost\/2026-08-21-site-fix-bug$/);
});
