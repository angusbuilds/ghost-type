// src/card.mjs
import fs from 'node:fs';

const DEFAULTS = { acceptanceTimeoutSec: 600, maxIterations: 6, maxTurns: 40, maxBudgetUsd: 4, situation: 'kickoff', engine: 'claude' };

export function validateCard(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('card: not an object');
  const c = { ...DEFAULTS, ...obj };
  for (const f of ['project', 'repoPath', 'goal', 'branch']) {
    if (typeof c[f] !== 'string' || !c[f].trim()) throw new Error(`card: missing/empty ${f}`);
  }
  if (!Array.isArray(c.acceptanceArgv) || c.acceptanceArgv.some(a => typeof a !== 'string'))
    throw new Error('card: acceptanceArgv must be an array of strings (never a shell string)');
  if (c.acceptanceArgv.length === 0) throw new Error('card: acceptanceArgv is empty');
  if (!c.branch.startsWith('ghost/')) throw new Error("card: branch must start with 'ghost/'");
  if (!['claude', 'codex'].includes(c.engine)) throw new Error("card: engine must be 'claude' or 'codex'");
  for (const n of ['acceptanceTimeoutSec', 'maxIterations', 'maxTurns', 'maxBudgetUsd']) {
    if (typeof c[n] !== 'number' || c[n] <= 0) throw new Error(`card: ${n} must be a positive number`);
  }
  return c;
}

export function loadCard(path) {
  return validateCard(JSON.parse(fs.readFileSync(path, 'utf8')));
}
