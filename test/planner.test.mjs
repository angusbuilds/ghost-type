// test/planner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCards, isCodingCard, branchName, slugify, countUnmergedGhostBranches } from '../src/planner.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('a repo whose runner is detected but UNAVAILABLE becomes a proposal, not a doomed coding card (round 4 #11)', () => {
  const d = { name: 'pyapp', repoPath: '/d/pyapp', testRunner: ['pytest', '-q'], canRunUnattended: false };
  const { cards } = planCards({ sendoff: 'x', dossiers: [d], dateStr: '2026-08-21' });
  assert.equal(cards[0].kind, 'proposal');
  assert.equal(isCodingCard(cards[0]), false);
  assert.match(cards[0].reason, /pytest.*not available/);
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

test('countUnmergedGhostBranches counts only unmerged ghost/* against a REAL repo (round 5 M4)', () => {
  // Runs the actual git command — the earlier form `--no-merged --list` died "malformed object
  // name" and this exercises the fixed order so it can't regress.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-unm-'));
  const g = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();
  g(d, 'init', '-q'); g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't');
  g(d, 'commit', '-q', '--allow-empty', '-m', 'init');
  const base = g(d, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  g(d, 'checkout', '-q', '-b', 'ghost/unmerged'); g(d, 'commit', '-q', '--allow-empty', '-m', 'work');
  g(d, 'checkout', '-q', base);
  g(d, 'checkout', '-q', '-b', 'ghost/merged'); g(d, 'checkout', '-q', base); g(d, 'merge', '-q', 'ghost/merged');
  assert.equal(countUnmergedGhostBranches(d, g), 1);   // only ghost/unmerged is in the backlog
  assert.equal(countUnmergedGhostBranches('/no/such/repo', g), 0);   // errors → 0
  fs.rmSync(d, { recursive: true, force: true });
});
