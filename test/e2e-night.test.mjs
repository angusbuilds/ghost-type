// test/e2e-night.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCard } from '../src/spine.mjs';
import { makeClone, fetchBranchBack } from '../src/clone.mjs';
import { runAcceptance } from '../src/verifier.mjs';

// A source repo whose test passes only after a sentinel file exists.
function repoWithFailingTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-e2e-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'check.mjs'),
    'import fs from "node:fs"; process.exit(fs.existsSync("FIXED") ? 0 : 1);');
  g('add', '-A'); g('commit', '-q', '-m', 'init');
  return dir;
}

test('card ships: clone → scripted fix → real acceptance passes → branch fetched back', async () => {
  const repo = repoWithFailingTest();
  const card = {
    project: 'e2e', repoPath: repo, goal: 'make check.mjs pass',
    acceptanceArgv: ['node', 'check.mjs'], acceptanceTimeoutSec: 20,
    branch: 'ghost/2026-08-21-e2e', maxIterations: 2, maxTurns: 5, maxBudgetUsd: 1, situation: 'kickoff',
  };

  const deps = {
    now: () => Date.now(),
    makeClone: (repoPath, id) => makeClone(repoPath, id),
    // the "engine" simulates the coding agent by creating the sentinel + branch in the clone
    runEngine: async ({ cwd }) => {
      // A local clone does not inherit the source repo's user.name/email, so set an
      // identity in the clone before committing — keeps the test hermetic (no reliance
      // on the machine's global git config, which CI runners lack).
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd });
      execFileSync('git', ['config', 'user.name', 't'], { cwd });
      execFileSync('git', ['checkout', '-b', card.branch], { cwd });
      fs.writeFileSync(path.join(cwd, 'FIXED'), '1');
      execFileSync('git', ['add', '-A'], { cwd });
      execFileSync('git', ['commit', '-q', '-m', 'fix'], { cwd });
      return { exitCode: 0, result: { subtype: 'success', result: 'done' }, usage: { input_tokens: 1, output_tokens: 1 }, text: 'done' };
    },
    commit: () => {}, // engine already committed in this simulation
    gitDiff: (cwd) => ({ stat: execFileSync('git', ['diff', '--shortstat', 'HEAD~1'], { cwd }).toString(), excerpt: 'added FIXED' }),
    verify: async (c, clonePath) => {
      const r = await runAcceptance(c.acceptanceArgv, clonePath, c.acceptanceTimeoutSec);
      return { pass: r.pass, detail: { testOutput: r.pass ? 'exit 0' : r.stderrHead } };
    },
    writeNextPrompt: async () => 'create the FIXED sentinel',
  };

  const r = await runCard(card, deps);
  assert.equal(r.outcome, 'shipped');

  // prove the branch can be pulled back into the real repo without a push
  const clonePath = path.join((await import('../src/lib.mjs')).WORK_DIR, card.branch.replace(/[^\w.-]/g, '_'));
  fetchBranchBack(repo, clonePath, card.branch);
  const branches = execFileSync('git', ['branch', '--list', card.branch], { cwd: repo }).toString();
  assert.match(branches, /ghost\/2026-08-21-e2e/);

  fs.rmSync(repo, { recursive: true, force: true });
});
