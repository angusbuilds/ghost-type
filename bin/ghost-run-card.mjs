#!/usr/bin/env node
// Live runner: drive ONE real card end to end against the real `claude` binary.
// Usage: node bin/ghost-run-card.mjs path/to/card.json
import { loadCard } from '../src/card.mjs';
import { runCard } from '../src/spine.mjs';
import { makeClone, fetchBranchBack } from '../src/clone.mjs';
import { runEngine } from '../src/engine.mjs';
import { runAcceptance, patchApplied, classifyClaim } from '../src/verifier.mjs';
import { writeNextPrompt, diagnoseFailure } from '../src/prompt-writer.mjs';
import { generateCandidates, voteBest } from '../src/preflight.mjs';
import { buildSessionEnv, allowedToolsFor } from '../src/env.mjs';
import { renderReport } from '../src/report.mjs';
import { WORK_DIR } from '../src/lib.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const card = loadCard(process.argv[2]);
const env = buildSessionEnv();
const allowedTools = allowedToolsFor(card.acceptanceArgv);
const git = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();

const deps = {
  now: () => Date.now(),
  makeClone,
  headRef: (clonePath) => git(clonePath, 'rev-parse', 'HEAD').trim(),
  patchApplied,
  // Writer calls (diagnosis/candidates/vote) run read-only, tiny-budget; coding calls get the full tool set.
  runEngine: ({ cwd, prompt, writer }) => runEngine({
    cwd, prompt,
    allowedTools: writer ? 'Read' : allowedTools,
    maxTurns: writer ? 1 : card.maxTurns,
    maxBudgetUsd: writer ? 1 : card.maxBudgetUsd,
    env,
  }),
  // Commit the result onto the card's branch. The clone is fresh, so this cleanly
  // captures whatever the agent left in the working tree (or its own commit).
  commit: (clonePath, branch) => {
    git(clonePath, 'config', 'user.email', 'ghost@ghosttype.local');
    git(clonePath, 'config', 'user.name', 'Ghost Type');
    try { git(clonePath, 'checkout', '-B', branch); } catch { /* already there */ }
    const dirty = git(clonePath, 'status', '--porcelain').trim();
    if (dirty) { git(clonePath, 'add', '-A'); git(clonePath, 'commit', '-q', '-m', `ghost: ${card.goal.slice(0, 60)}`); }
  },
  gitDiff: (cwd) => ({
    stat: git(cwd, 'diff', '--shortstat', 'HEAD'),
    excerpt: git(cwd, 'diff', 'HEAD').slice(0, 12000),
  }),
  verify: async (c, clonePath) => {
    const r = await runAcceptance(c.acceptanceArgv, clonePath, c.acceptanceTimeoutSec);
    return { pass: r.pass, detail: { testOutput: r.pass ? 'acceptance passed (exit 0)' : r.stderrHead } };
  },
  classifyClaim,
  diagnoseFailure,
  generateCandidates,
  voteBest,
  writeNextPrompt,
  sleepUntil: (ms) => new Promise(res => setTimeout(res, Math.min(Math.max(ms - Date.now(), 0), 3600_000))),
};

console.error(`👻 driving card "${card.project}" — goal: ${card.goal}`);
const result = await runCard(card, deps);
if (result.mergeReady) {
  const clonePath = path.join(WORK_DIR, card.branch.replace(/[^\w.-]/g, '_'));
  fetchBranchBack(card.repoPath, clonePath, card.branch);
}
console.log('\n' + renderReport({ date: new Date().toISOString().slice(0, 10), cards: [result], tokens: 0, costUsd: 0 }));
