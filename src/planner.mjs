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

// The branch name is deterministic (date+project+goal), so re-running the SAME goal on the SAME day
// would target a branch that already exists — and fetchBranchBack's non-forced fetch would reject
// the second run as non-fast-forward, silently discarding a whole night's work (round 18 #11). Keep
// the clean name in the common case; only when it already exists, allocate the next free -2/-3/... so
// both runs land as reviewable sibling branches instead of one being lost.
export function disambiguateBranch(base, taken = []) {
  const seen = new Set(taken);
  if (!seen.has(base)) return base;
  for (let n = 2; ; n++) { const cand = `${base}-${n}`; if (!seen.has(cand)) return cand; }
}

// The ghost/* branch names that already exist as refs in a repo, so planning can avoid colliding with
// them. `git` is injectable as (cwd, ...args) => stdout for tests. Returns [] on any error/empty repo.
export function listGhostBranches(repoPath, git) {
  try {
    const out = git(repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ghost/').trim();
    return out ? out.split('\n').map(s => s.trim()).filter(Boolean) : [];
  } catch { return []; }
}

// unmergedByProject: { projectName: count } — projects over the backpressure threshold are
// skipped so overnight supply can't outrun the owner's review capacity.
export function planCards({ sendoff, dossiers, dateStr, unmergedByProject = {}, existingBranchesByProject = {}, maxCards = 2, backpressureThreshold = 3, engine = 'claude' }) {
  const cards = [];
  const paused = [];
  for (const d of dossiers) {
    if ((unmergedByProject[d.name] || 0) >= backpressureThreshold) { paused.push(d.name); continue; }
    const goal = (sendoff && sendoff.trim()) || `continue the current work on ${d.name}`;
    // Avoid an already-existing branch so a same-day rerun ships a sibling instead of being non-ff-rejected (#11).
    const branch = disambiguateBranch(branchName(d.name, dateStr, goal), existingBranchesByProject[d.name] || []);
    // A repo is codeable only if it has a runner AND that runner is actually usable. When a
    // scan set canRunUnattended, honor it (it already folds in executable availability, round
    // 4 #11); hand-built dossiers without the flag fall back to runner-presence.
    const runnable = d.canRunUnattended !== undefined ? d.canRunUnattended : Boolean(d.testRunner);
    if (d.testRunner && runnable) {
      cards.push(validateCard({
        project: d.name, repoPath: d.repoPath, goal,
        acceptanceArgv: d.testRunner, acceptanceTimeoutSec: 600, branch,
        maxIterations: 6, maxTurns: 40, maxBudgetUsd: 4, situation: 'kickoff', engine,
      }));
    } else {
      // proposal-only: can't be graded unattended, so it writes a plan file, spends no
      // iteration/token budget, and is reported as its own category.
      cards.push({
        project: d.name, repoPath: d.repoPath, goal, branch, kind: 'proposal',
        // Prefer a specific dossier reason (e.g. an unborn repo) over the generic runner message (round 18 #8).
        reason: d.unrunnableReason
             || (d.testRunner ? `test runner "${d.testRunner[0]}" not available on PATH — cannot verify unattended`
                              : 'no test runner detected — cannot verify unattended'),
        situation: 'kickoff',
      });
    }
    if (cards.length >= maxCards) break;
  }
  return { cards, paused };
}

export function isCodingCard(card) { return card.kind !== 'proposal' && Array.isArray(card.acceptanceArgv) && card.acceptanceArgv.length > 0; }

// Count a project's ghost/* branches NOT yet merged into HEAD — the review backlog that feeds
// backpressure. `git` is injectable as (cwd, ...args) => stdout so this is testable against a
// real repo. NOTE: `--list <pattern>` must come before `--no-merged` or git reads the pattern
// as the optional commit and dies "malformed object name". Returns 0 on any error.
export function countUnmergedGhostBranches(repoPath, git) {
  try {
    const out = git(repoPath, 'branch', '--list', 'ghost/*', '--no-merged').trim();
    return out ? out.split('\n').filter(Boolean).length : 0;
  } catch { return 0; }
}
