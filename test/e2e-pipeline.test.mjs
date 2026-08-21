// test/e2e-pipeline.test.mjs
// Full-pipeline e2e with ZERO mocks except the LLM itself (scripted, since tests spend no
// tokens). Real git clones, real filesystem, real test execution, real commits, real
// branch-back, real deletion guard, real governor accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCard } from '../src/spine.mjs';
import { makeClone, fetchBranchBack } from '../src/clone.mjs';
import { runAcceptance, patchApplied, suspiciousDeletion } from '../src/verifier.mjs';
import { Governor } from '../src/governor.mjs';
import { WORK_DIR } from '../src/lib.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();

function newRepo(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-e2e-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  seed(dir);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// REAL deps — only `runEngine` is scripted (stands in for the model).
function realDeps(repo, runEngine, extra = {}) {
  return {
    now: () => Date.now(),
    makeClone,
    headRef: (clonePath) => git(clonePath, 'rev-parse', 'HEAD').trim(),
    patchApplied,
    runEngine,
    commit: (clonePath, branch) => {
      git(clonePath, 'config', 'user.email', 'ghost@t'); git(clonePath, 'config', 'user.name', 'ghost');
      try { git(clonePath, 'checkout', '-B', branch); } catch { /* already */ }
      if (git(clonePath, 'status', '--porcelain').trim()) { git(clonePath, 'add', '-A'); git(clonePath, 'commit', '-q', '-m', 'ghost'); }
    },
    gitDiff: (cwd) => ({ stat: git(cwd, 'diff', '--shortstat', 'HEAD'), excerpt: git(cwd, 'diff', 'HEAD').slice(0, 4000) }),
    verify: async (c, clonePath) => {
      const r = await runAcceptance(c.acceptanceArgv, clonePath, c.acceptanceTimeoutSec);
      if (!r.pass) return { pass: false, detail: { testOutput: r.stderrHead || 'test failed' } };
      const stat = git(clonePath, 'diff', '--shortstat', 'HEAD').trim();
      if (suspiciousDeletion(c.goal, stat)) return { pass: false, detail: { testOutput: `deletion-guard: ${stat}` } };
      return { pass: true, detail: { testOutput: 'ok' } };
    },
    // scripted writer bits (stand in for the model)
    diagnoseFailure: async () => 'the file was not created',
    generateCandidates: async () => [],
    voteBest: async ({ candidates }) => ({ choice: candidates[0], index: 0 }),
    writeNextPrompt: async () => 'create the FIXED file',
    ...extra,
  };
}

test('E2E: real clone → no-patch guard → real fix → real test passes → real commit → branch fetched back', async () => {
  const repo = newRepo((d) => fs.writeFileSync(path.join(d, 'check.mjs'),
    'import fs from "node:fs"; process.exit(fs.existsSync("FIXED") ? 0 : 1);'));
  const card = {
    project: 'e2e', repoPath: repo, goal: 'create a FIXED file so check passes',
    acceptanceArgv: ['node', 'check.mjs'], acceptanceTimeoutSec: 20,
    branch: 'ghost/e2e-fix', maxIterations: 3, maxTurns: 5, maxBudgetUsd: 1, situation: 'kickoff', engine: 'claude',
  };
  let iter = 0;
  const runEngine = async ({ cwd }) => {
    iter += 1;
    if (iter >= 2) fs.writeFileSync(path.join(cwd, 'FIXED'), '1');   // fix on the 2nd attempt
    return { exitCode: 0, result: { subtype: 'success', result: 'done' }, usage: { input_tokens: 100, output_tokens: 50 }, text: 'done' };
  };
  const gov = new Governor({ maxTokensNight: 1e9, nightDeadlineMs: Date.now() + 3600_000, maxConsecErrors: 9 });
  const r = await runCard(card, realDeps(repo, runEngine, { governor: gov }));

  assert.equal(r.outcome, 'shipped');
  assert.ok(r.tokensUsed >= 300, 'governor metered real token usage across attempts');
  assert.equal(gov.tokens, r.tokensUsed);

  // real branch-back into the source repo, without a push
  const clonePath = path.join(WORK_DIR, card.branch.replace(/[^\w.-]/g, '_'));
  fetchBranchBack(repo, clonePath, card.branch);
  assert.match(git(repo, 'branch', '--list', card.branch), /ghost\/e2e-fix/);
  // main is untouched — no FIXED on it
  assert.doesNotMatch(git(repo, 'ls-tree', '--name-only', 'HEAD'), /FIXED/);
  // clone objects are separate inodes (--no-hardlinks)
  const srcObj = path.join(repo, '.git', 'objects');
  const dirs = fs.readdirSync(srcObj).filter(n => n.length === 2);
  if (dirs.length) {
    const sub = path.join(srcObj, dirs[0]); const f = fs.readdirSync(sub)[0];
    const cloneObj = path.join(clonePath, '.git', 'objects', dirs[0], f);
    if (fs.existsSync(cloneObj)) assert.notEqual(fs.statSync(cloneObj).ino, fs.statSync(path.join(sub, f)).ino);
  }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(clonePath, { recursive: true, force: true });
});

test('E2E: the deletion guard refuses a net-negative diff even when the test passes', async () => {
  const repo = newRepo((d) => {
    fs.writeFileSync(path.join(d, 'always-pass.mjs'), 'process.exit(0);');
    fs.writeFileSync(path.join(d, 'feature.js'), Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`).join('\n'));
  });
  const card = {
    project: 'del', repoPath: repo, goal: 'add a lazy-load feature to the gallery',
    acceptanceArgv: ['node', 'always-pass.mjs'], acceptanceTimeoutSec: 20,
    branch: 'ghost/del', maxIterations: 1, maxTurns: 5, maxBudgetUsd: 1, situation: 'kickoff', engine: 'claude',
  };
  const runEngine = async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'feature.js'), 'const line0 = 0;');   // deleted 59 lines = net-negative
    return { exitCode: 0, result: { subtype: 'success', result: 'done' }, usage: { input_tokens: 10, output_tokens: 5 }, text: 'all done' };
  };
  const r = await runCard(card, realDeps(repo, runEngine));
  assert.equal(r.outcome, 'parked');
  assert.match(r.testOutput, /deletion-guard/);   // test passed but the guard refused it
  const clonePath = path.join(WORK_DIR, card.branch.replace(/[^\w.-]/g, '_'));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(clonePath, { recursive: true, force: true });
});
