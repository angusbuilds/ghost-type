#!/usr/bin/env node
// Live runner: drive ONE real card end to end against the real `claude` binary.
// Usage: node bin/ghost-run-card.mjs path/to/card.json
import { loadCard } from '../src/card.mjs';
import { runCard } from '../src/spine.mjs';
import { makeClone, fetchBranchBack, commitTreeRef } from '../src/clone.mjs';
import { runAgent } from '../src/engine.mjs';
import { shapeForEngine } from '../src/engine-rules.mjs';
import { verifyCard, patchApplied, classifyClaim } from '../src/verifier.mjs';
import { writeNextPrompt, diagnoseFailure } from '../src/prompt-writer.mjs';
import { generateCandidates, voteBest } from '../src/preflight.mjs';
import { buildSessionEnv, allowedToolsFor } from '../src/env.mjs';
import { loadConfig } from '../src/config.mjs';
import { renderReport } from '../src/report.mjs';
import { WORK_DIR } from '../src/lib.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const card = loadCard(process.argv[2]);
const CONFIG = loadConfig();
const env = buildSessionEnv([], process.env, card.engine);   // scope creds to the card's engine (round 5 M9)
const allowedTools = allowedToolsFor(card.acceptanceArgv);
const git = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();

const deps = {
  now: () => Date.now(),
  makeClone,
  headRef: (clonePath) => git(clonePath, 'rev-parse', 'HEAD').trim(),
  patchApplied,
  // Dispatch by the CARD's engine (round 6 #7 — was hardwired to Claude, so a Codex card ran
  // Claude with OpenAI creds). Writer calls (diagnosis/candidates/vote) run read-only,
  // tiny-budget; coding calls get the shaped prompt + full tool set.
  runEngine: ({ cwd, prompt, writer }) => runAgent({
    engine: card.engine, cwd,
    prompt: writer ? prompt : shapeForEngine(prompt, card.engine, card),
    allowedTools: writer ? 'Read' : allowedTools,       // Claude read-only tools for writer
    sandbox: writer ? 'read-only' : 'workspace-write',  // Codex read-only sandbox for writer
    sandboxClone: CONFIG.sandbox ? cwd : undefined,     // OS write-confinement — was missing here (round 9 Critical)
    maxTurns: writer ? 1 : card.maxTurns,
    maxBudgetUsd: writer ? 1 : card.maxBudgetUsd,
    env,
  }),
  // Commit the result onto the card's branch. The clone is fresh, so this cleanly
  // captures whatever the agent left in the working tree (or its own commit).
  commit: (clonePath, branch, { tree, baseRef } = {}) => {
    git(clonePath, 'config', 'user.email', 'ghost@ghosttype.local');
    git(clonePath, 'config', 'user.name', 'Ghost Type');
    const msg = `ghost: ${card.goal.slice(0, 60)}`;
    if (tree && baseRef) return commitTreeRef(git, clonePath, branch, tree, baseRef, msg);   // hook-free ship → returns OID (round 13/14)
    try { git(clonePath, 'checkout', '-B', branch); } catch { /* already there */ }
    const dirty = git(clonePath, 'status', '--porcelain').trim();
    if (dirty) { git(clonePath, 'add', '-A'); git(clonePath, 'commit', '-q', '--no-verify', '-m', msg); }
    return git(clonePath, 'rev-parse', 'HEAD').trim();
  },
  gitDiff: (cwd) => {
    // --no-ext-diff --no-textconv + fsmonitor/hooks off — a planted diff config can't execute in the daemon (round 15).
    const D = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'diff', '--no-ext-diff', '--no-textconv'];
    return { stat: git(cwd, ...D, '--shortstat', 'HEAD'), excerpt: git(cwd, ...D, 'HEAD').slice(0, 12000) };
  },
  // Shared verifier — includes the deletion guard, so this packaged runner can't ship a
  // destructive diff on a passing test (round 5 H1); sandbox the acceptance test when configured.
  verify: (c, clonePath, opts) => verifyCard(c, clonePath, { ...opts, sandbox: CONFIG.sandbox }),
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
  // Match the daemon: a fetch failure parks with the REAL error, not a contradictory
  // outcome:'shipped'/'acceptance passed' report (round 20 #6). The clone is left intact.
  try { fetchBranchBack(card.repoPath, clonePath, card.branch, result.commitOid); }
  catch (e) { console.error('⚠', e.message); result.mergeReady = false; result.outcome = 'parked'; result.whyLine = `verified but could not fetch the branch back: ${String(e.message).split('\n')[0]}`; }
}
console.log('\n' + renderReport({ date: new Date().toISOString().slice(0, 10), cards: [result], tokens: result.tokensUsed || 0, costUsd: result.costUsd || 0 }));
