#!/usr/bin/env node
// Manual live-smoke: run ONE real card end to end against the real claude binary.
// Usage: node bin/ghost-run-card.mjs path/to/card.json
import { loadCard } from '../src/card.mjs';
import { runCard } from '../src/spine.mjs';
import { makeClone, fetchBranchBack } from '../src/clone.mjs';
import { runEngine } from '../src/engine.mjs';
import { runAcceptance } from '../src/verifier.mjs';
import { writeNextPrompt } from '../src/prompt-writer.mjs';
import { buildSessionEnv, allowedToolsFor } from '../src/env.mjs';
import { renderReport } from '../src/report.mjs';
import { WORK_DIR } from '../src/lib.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const card = loadCard(process.argv[2]);
const env = buildSessionEnv();
const allowedTools = allowedToolsFor(card.acceptanceArgv);

const deps = {
  now: () => Date.now(),
  makeClone,
  runEngine: ({ cwd, prompt }) => runEngine({ cwd, prompt, allowedTools, maxTurns: card.maxTurns, maxBudgetUsd: card.maxBudgetUsd, env }),
  commit: () => {}, // the agent commits inside the clone via allowed git tools
  gitDiff: (cwd) => ({
    stat: execFileSync('git', ['diff', '--shortstat', 'HEAD'], { cwd }).toString(),
    excerpt: execFileSync('git', ['diff', 'HEAD'], { cwd }).toString().slice(0, 12000),
  }),
  verify: async (c, clonePath) => {
    const r = await runAcceptance(c.acceptanceArgv, clonePath, c.acceptanceTimeoutSec);
    return { pass: r.pass, detail: { testOutput: r.pass ? 'exit 0' : r.stderrHead } };
  },
  writeNextPrompt,
  sleepUntil: (ms) => new Promise(res => setTimeout(res, Math.min(Math.max(ms - Date.now(), 0), 3600_000))),
};

const result = await runCard(card, deps);
if (result.mergeReady) {
  const clonePath = path.join(WORK_DIR, card.branch.replace(/[^\w.-]/g, '_'));
  fetchBranchBack(card.repoPath, clonePath, card.branch);
}
console.log(renderReport({ date: new Date().toISOString().slice(0, 10), cards: [result], tokens: 0, costUsd: 0 }));
