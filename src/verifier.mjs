// src/verifier.mjs
import { spawn, execFileSync } from 'node:child_process';
import { byteCap } from './lib.mjs';
import { fence, scrubSecrets } from './sanitize.mjs';
import { buildSessionEnv } from './env.mjs';

// Run the card's acceptance command OURSELVES as an argv spawn (never a shell).
// Pass = exit 0 within timeout. The agent's own "done" claim is never trusted. The command is
// project code the agent may have modified, so it runs with a CREDENTIAL-STRIPPED environment
// (engine 'none' → no API keys) and in its own process group that the timeout kills wholesale —
// a grandchild holding stdout can no longer deadlock us past the timeout (round 6 #1).
// (An OS sandbox with restricted fs/network is the remaining hardening, tracked separately.)
export function runAcceptance(argv, cwd, timeoutSec, env = buildSessionEnv([], process.env, 'none')) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true });
    const CAP = 256 * 1024;
    let out = '', outBytes = 0, err = '', errBytes = 0;
    let timedOut = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutSec * 1000);
    // Drain BOTH streams, bounded. An unconsumed stdout fills the OS pipe buffer and deadlocks
    // a chatty test into a false timeout (round 5 M1); and most runners (node --test, pytest)
    // report failures on STDOUT, which the old code discarded — so capture it for the diagnostic.
    child.stdout.on('data', d => { if (outBytes < CAP) { out += d; outBytes += d.length; } });
    child.stderr.on('data', d => { if (errBytes < CAP) { err += d; errBytes += d.length; } });
    child.on('close', (code) => {
      clearTimeout(timer);
      const diag = [err.trim(), out.trim()].filter(Boolean).join('\n').split('\n').slice(0, 12).join('\n');
      resolve({ pass: !timedOut && code === 0, code, stderrHead: diag, timedOut });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ pass: false, code: null, stderrHead: String(e.message), timedOut }); });
  });
}

// Centralized acceptance + safety verification — EVERY runner MUST call this, so no entrypoint
// can ship on a passing test alone while a destructive diff slips through (round 5 H1: the
// packaged ghost-run-card runner had no deletion guard). `baseRef` lets the guard see committed
// changes too (round 4 #1); `git` is injectable for tests.
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();
export async function verifyCard(card, clonePath, { baseRef, git = gitOut } = {}) {
  const r = await runAcceptance(card.acceptanceArgv, clonePath, card.acceptanceTimeoutSec);
  if (!r.pass) return { pass: false, detail: { testOutput: r.stderrHead || 'test failed' } };
  const ref = baseRef || 'HEAD';
  const stat = git(clonePath, 'diff', '--shortstat', ref, '--').trim();
  if (suspiciousDeletion(card.goal, stat)) {
    return { pass: false, detail: { testOutput: `test passed but the diff is net-negative for a build goal — refusing (${stat})` } };
  }
  // Deeper per-file / deleted-file inspection catches gutting a file under a "fix" goal and
  // padded net-positive diffs that delete a test (round 6 #3).
  const reason = destructiveDiffReason(card.goal,
    git(clonePath, 'diff', '--numstat', ref, '--').trim(),
    git(clonePath, 'diff', '--name-status', ref, '--').trim());
  if (reason) return { pass: false, detail: { testOutput: `test passed but the change looks destructive — refusing (${reason})` } };
  return { pass: true, detail: { testOutput: 'acceptance passed (exit 0)' } };
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

// A goal that EXPLICITLY asks to delete/remove — only then is a net-negative diff expected.
const DELETION_GOAL = /\b(delete|remove|drop|clean\s*up|dead\s*code|prune|strip|deprecate|get\s*rid)\b/i;
// Test/spec/config files whose deletion is almost always "make it pass by removing the test".
const TESTISH = /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[a-z]+$|(^|\/)conftest\.py$|_test\.[a-z]+$/i;

// Stronger destructive-change guard: inspects per-file deltas (`--numstat`) and deleted files
// (`--name-status`), not just shortstat totals, so a non-"build" goal that guts a file, or a
// padded net-positive diff that deletes a test, still fails (round 6 #3). Returns a reason or null.
export function destructiveDiffReason(goal, numstat = '', nameStatus = '') {
  if (DELETION_GOAL.test(String(goal))) return null;   // deletion was explicitly requested
  for (const l of String(nameStatus).split('\n')) {
    const m = l.match(/^D\t(.+)$/);
    if (m && TESTISH.test(m[1])) return `deletes test file ${m[1]}`;
  }
  for (const l of String(numstat).split('\n')) {
    const [add, del, file] = l.split('\t');
    if (file && /^\d+$/.test(add) && /^\d+$/.test(del) && Number(del) - Number(add) > 100) {
      return `${file} lost ${Number(del) - Number(add)} net lines`;
    }
  }
  return null;
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
