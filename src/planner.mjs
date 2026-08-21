// src/planner.mjs
// Turn a send-off line + project dossiers into tonight's queue of task cards. Deterministic
// core (no model needed to plan): the goal comes from the send-off, the acceptance command
// from the dossier's detected runner. A repo with no runner becomes a proposal-only card.
import { validateCard } from './card.mjs';

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'work';
}

export function branchName(project, dateStr, goal) {
  return `ghost/${dateStr}-${slugify(project)}-${slugify(goal)}`;
}

// unmergedByProject: { projectName: count } — projects over the backpressure threshold are
// skipped so overnight supply can't outrun the owner's review capacity.
export function planCards({ sendoff, dossiers, dateStr, unmergedByProject = {}, maxCards = 2, backpressureThreshold = 3 }) {
  const cards = [];
  const paused = [];
  for (const d of dossiers) {
    if ((unmergedByProject[d.name] || 0) >= backpressureThreshold) { paused.push(d.name); continue; }
    const goal = (sendoff && sendoff.trim()) || `continue the current work on ${d.name}`;
    const branch = branchName(d.name, dateStr, goal);
    if (d.testRunner) {
      cards.push(validateCard({
        project: d.name, repoPath: d.repoPath, goal,
        acceptanceArgv: d.testRunner, acceptanceTimeoutSec: 600, branch,
        maxIterations: 6, maxTurns: 40, maxBudgetUsd: 4, situation: 'kickoff',
      }));
    } else {
      // proposal-only: can't be graded unattended, so it writes a plan file, spends no
      // iteration/token budget, and is reported as its own category.
      cards.push({
        project: d.name, repoPath: d.repoPath, goal, branch, kind: 'proposal',
        reason: 'no test runner detected — cannot verify unattended', situation: 'kickoff',
      });
    }
    if (cards.length >= maxCards) break;
  }
  return { cards, paused };
}

export function isCodingCard(card) { return card.kind !== 'proposal' && Array.isArray(card.acceptanceArgv) && card.acceptanceArgv.length > 0; }
