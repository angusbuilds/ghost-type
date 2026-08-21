// src/verifier.mjs
import { spawn, execFileSync } from 'node:child_process';
import { byteCap } from './lib.mjs';
import { fence, scrubSecrets } from './sanitize.mjs';

// Run the card's acceptance command OURSELVES as an argv spawn (never a shell).
// Pass = exit 0 within timeout. The agent's own "done" claim is never trusted.
export function runAcceptance(argv, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd });
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutSec * 1000);
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ pass: !timedOut && code === 0, code, stderrHead: err.split('\n').slice(0, 5).join('\n'), timedOut });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ pass: false, code: null, stderrHead: String(e.message), timedOut }); });
  });
}

// Cheapest guard: did the working tree actually change vs the base commit the session
// started from? An empty patch fails fast without spending a full acceptance-test run.
export function patchApplied(clonePath, baseRef) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: clonePath }).toString().trim();
  if (out) return true;
  const diff = execFileSync('git', ['diff', '--stat', `${baseRef}..HEAD`], { cwd: clonePath }).toString().trim();
  return diff.length > 0;
}

const DONE_CLAIM = /\b(all tests pass|tests pass|done|complete|finished|implemented|fixed it|works now)\b/i;

// Ground the session's completion claim against the Verifier's own test result.
// A "done" claim with a failing verify is a false-done — the highest-value catch.
export function classifyClaim({ claimText, verifyPass }) {
  const claimedDone = DONE_CLAIM.test(String(claimText || ''));
  return { claimedDone, falseDone: claimedDone && !verifyPass };
}

// Cheap non-LLM cross-check: a net-negative "feature" diff is suspect (agent may
// have deleted the thing under test). Parses `git diff --shortstat`.
export function netLinesGutted(diffStat) {
  const ins = Number((diffStat.match(/(\d+) insertion/) || [])[1] || 0);
  const del = Number((diffStat.match(/(\d+) deletion/) || [])[1] || 0);
  return del > ins;
}

// The "fixed the bug by deleting the feature" guard: a build/add goal whose diff is
// net-negative is suspicious even if the test passed. Cheap, no tokens.
const BUILD_GOAL = /\b(add|build|make|create|implement|support|feature|new)\b/i;
export function suspiciousDeletion(goal, diffStat) {
  return BUILD_GOAL.test(String(goal)) && netLinesGutted(String(diffStat));
}

// LLM judge, fed only fenced/scrubbed diff text. Fail-closed: anything but a clear
// yes is treated as not-implemented by the caller.
export async function diffSanity({ goal, diffStat, diffExcerpt, engine }) {
  const prompt = [
    'You are judging whether a code change actually implements a goal or just deletes/guts code.',
    `GOAL: ${goal}`,
    `DIFF STAT: ${diffStat}`,
    fence('diff', byteCap(scrubSecrets(diffExcerpt), 12000)),
    'Answer strictly with a JSON object: {"implemented": true|false, "reason": "..."}.',
  ].join('\n\n');
  const r = await engine({ prompt });
  try {
    const m = r.text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m[0]);
    return { implemented: j.implemented === true, reason: String(j.reason || '') };
  } catch {
    return { implemented: false, reason: 'unparseable judge output (fail-closed)' };
  }
}
