// test/coverage-meta.test.mjs
// A guard against the gap that let src/sandbox.mjs ship with ZERO tests (round 31): every source
// module must be imported by at least one test file. It doesn't measure line coverage — it catches
// the coarse, high-risk case of a whole module (often a security boundary) that no test exercises at
// all. Test-file names need not match module names (engine→codex/engine-parse, notify→m4, …); what
// matters is that SOMETHING imports it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const testDir = path.join(root, 'test');

test('every src/*.mjs module is imported by at least one test file (no whole-module coverage gap)', () => {
  const modules = fs.readdirSync(srcDir).filter(f => f.endsWith('.mjs')).map(f => f.replace(/\.mjs$/, ''));
  const testSources = fs.readdirSync(testDir).filter(f => f.endsWith('.test.mjs'))
    .map(f => fs.readFileSync(path.join(testDir, f), 'utf8')).join('\n');
  const untested = modules.filter(m => !testSources.includes(`../src/${m}.mjs`));
  assert.deepEqual(untested, [], `these src modules have NO test importing them: ${untested.join(', ')}`);
});
