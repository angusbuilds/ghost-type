// src/verifier.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { byteCap } from './lib.mjs';
import { fence, scrubSecrets } from './sanitize.mjs';
import { buildSessionEnv } from './env.mjs';
import { sandboxNetDeny } from './sandbox.mjs';

// STERILE snapshot of the candidate: build a tree from RAW filesystem bytes via `hash-object
// --no-filters`, in a throwaway index, with every executable git-config path disabled. This
// bypasses the entire check-in pipeline a malicious repo could weaponize — clean/process filters
// (arbitrary code + byte substitution), ident/eol/encoding transforms, fsmonitor (an executable
// hook), and index-flag tricks like assume-unchanged/skip-worktree — so the frozen tree is exactly
// the bytes acceptance tested and `git add` can't run a planted helper (round 15). Throws on a
// dirty submodule (its inner bytes can affect the test but aren't in the tree). Returns a tree OID.
const STERILE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false'];
export function sterileTree(clonePath) {
  const run = (input, ...args) => execFileSync('git', [...STERILE, ...args], { cwd: clonePath, input, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
  const hashStdin = (input) => execFileSync('git', [...STERILE, 'hash-object', '-w', '--stdin'], { cwd: clonePath, input, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
  const indexLines = [];      // "<mode> <oid>\t<path>" for update-index --index-info
  const batch = [];           // regular files hashed together in ONE git process
  // Add ONE worktree entry, re-hashing from DISK (defeats stale-index tricks). Rejects special
  // files (FIFO/socket/device) whose `git hash-object` would block the daemon forever (round 16).
  const addWorktree = (f) => {
    let st;
    try { st = fs.lstatSync(path.join(clonePath, f)); } catch { return; }   // vanished between listing and hashing
    if (st.isSymbolicLink()) { indexLines.push(`120000 ${hashStdin(fs.readlinkSync(path.join(clonePath, f)))}\t${f}`); return; }
    if (!st.isFile()) throw new Error(`refusing to snapshot special file (FIFO/socket/device/dir) at ${f}`);
    const mode = (st.mode & 0o111) ? '100755' : '100644';
    if (f.includes('\n')) indexLines.push(`${mode} ${hashStdin(fs.readFileSync(path.join(clonePath, f)))}\t${f}`);   // stdin-paths is newline-delimited
    else batch.push({ f, mode });
  };
  // Tracked entries WITH modes so a submodule GITLINK (160000) is PRESERVED by its recorded commit
  // — a normal repo containing a submodule must still snapshot faithfully (round 16). A gitlink whose
  // checked-out HEAD no longer matches the recorded commit is refused (its real bytes aren't captured).
  for (const line of run(undefined, 'ls-files', '--stage', '-z').split('\0').filter(Boolean)) {
    const m = line.match(/^(\d+) ([0-9a-f]+) \d+\t([\s\S]*)$/);
    if (!m) continue;
    const [, mode, oid, f] = m;
    if (mode === '160000') {
      const sub = path.join(clonePath, f);
      if (fs.existsSync(path.join(sub, '.git'))) {
        let head = '';
        try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sub, stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim(); } catch { /* uninitialized */ }
        if (head && head !== oid) throw new Error(`submodule ${f} HEAD ${head} != recorded ${oid} — refusing (its bytes aren't in the frozen tree)`);
      }
      indexLines.push(`160000 ${oid}\t${f}`);
    } else addWorktree(f);
  }
  // Untracked new files (respecting .gitignore).
  for (const f of run(undefined, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) addWorktree(f);
  // Batch-hash all ordinary files in ONE process (was one spawn/file — 6.8s → ~0.1s for 400 files).
  if (batch.length) {
    const oids = run(batch.map(b => path.join(clonePath, b.f)).join('\n') + '\n', 'hash-object', '-w', '--no-filters', '--stdin-paths').trim().split('\n');
    batch.forEach((b, i) => indexLines.push(`${b.mode} ${oids[i]}\t${b.f}`));
  }
  // Build the throwaway index in ONE update-index --index-info, then write the tree.
  const idx = path.join(clonePath, '.git', `ghost-idx-${crypto.randomBytes(6).toString('hex')}`);
  const withIdx = (input, ...args) => execFileSync('git', [...STERILE, ...args], { cwd: clonePath, env: { ...process.env, GIT_INDEX_FILE: idx }, input, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
  try {
    if (indexLines.length) withIdx(indexLines.join('\n') + '\n', 'update-index', '--index-info');
    return withIdx(undefined, 'write-tree').trim();
  } finally { try { fs.unlinkSync(idx); } catch { /* best effort */ } }
}

// Run the card's acceptance command OURSELVES as an argv spawn (never a shell).
// Pass = exit 0 within timeout. The agent's own "done" claim is never trusted. The command is
// project code the agent may have modified, so it runs with a CREDENTIAL-STRIPPED environment
// (engine 'none' → no API keys) and in its own process group that the timeout kills wholesale —
// a grandchild holding stdout can no longer deadlock us past the timeout (round 6 #1). With
// `sandbox: true` it is additionally wrapped in an OS network/credential jail (macOS).
export function runAcceptance(argv, cwd, timeoutSec, env = buildSessionEnv([], process.env, 'none'), sandbox = false) {
  return new Promise((resolve) => {
    const eff = sandbox ? sandboxNetDeny(argv) : argv;
    const child = spawn(eff[0], eff.slice(1), { cwd, env, detached: true });
    const CAP = 256 * 1024;
    let out = '', outBytes = 0, err = '', errBytes = 0;
    let settled = false;
    const diagOf = () => [err.trim(), out.trim()].filter(Boolean).join('\n').split('\n').slice(0, 12).join('\n');
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    // Settle at the deadline INDEPENDENTLY of 'close' — a detached grandchild holding our stdout
    // would otherwise delay 'close' well past the timeout (round 7 High#1).
    const timer = setTimeout(() => {
      kill();
      try { child.unref(); child.stdout.destroy(); child.stderr.destroy(); } catch { /* gone */ }
      finish({ pass: false, code: null, stderrHead: diagOf(), timedOut: true });
    }, timeoutSec * 1000);
    // Drain BOTH streams, bounded. An unconsumed stdout fills the OS pipe buffer and deadlocks
    // a chatty test into a false timeout (round 5 M1); and most runners (node --test, pytest)
    // report failures on STDOUT, which the old code discarded — so capture it for the diagnostic.
    child.stdout.on('data', d => { if (outBytes < CAP) { out += d; outBytes += d.length; } });
    child.stderr.on('data', d => { if (errBytes < CAP) { err += d; errBytes += d.length; } });
    child.on('close', (code) => finish({ pass: code === 0, code, stderrHead: diagOf(), timedOut: false }));
    child.on('error', (e) => finish({ pass: false, code: null, stderrHead: String(e.message), timedOut: false }));
  });
}

// Centralized acceptance + safety verification — EVERY runner MUST call this, so no entrypoint
// can ship on a passing test alone while a destructive diff slips through (round 5 H1: the
// packaged ghost-run-card runner had no deletion guard). `baseRef` lets the guard see committed
// changes too (round 4 #1); `git` is injectable for tests.
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();
export async function verifyCard(card, clonePath, { baseRef, git = gitOut, sandbox = false, acceptanceTimeoutSec } = {}) {
  const ref = baseRef || 'HEAD';
  // FREEZE the full candidate tree — tracked mods AND untracked new files (git add -A respects
  // .gitignore, so build artifacts don't count) — BEFORE the agent-modifiable test runs. write-tree
  // hashes CONTENT, so any later change is visible: erasing an untracked file, corrupting content
  // in place, or committing a different tree all change the hash (round 11: the round-10 filename-
  // only check missed untracked deletion + corruption + commit-over).
  // Snapshot from RAW filesystem bytes so no candidate-controlled git config can execute a helper
  // or store bytes ≠ what acceptance tested (round 14/15). FAIL CLOSED: a snapshot failure refuses
  // verification rather than skipping the mutation check and letting an empty diff ship (round 12).
  const freeze = () => sterileTree(clonePath);
  let treeBefore;
  try { treeBefore = freeze(); }
  catch (e) { return { pass: false, detail: { testOutput: `could not snapshot the candidate for verification — refusing: ${e.message}` } }; }
  // acceptanceTimeoutSec (from the governor's remaining time) caps the test so it can't run its
  // full card timeout past the nightly deadline (round 8 Medium).
  const r = await runAcceptance(card.acceptanceArgv, clonePath, acceptanceTimeoutSec ?? card.acceptanceTimeoutSec, undefined, sandbox);
  if (!r.pass) return { pass: false, detail: { testOutput: r.stderrHead || 'test failed' } };
  // A rigged test that erased/rewrote its own changes to fake a pass now shows a different tree.
  // A snapshot failure here (e.g. the test planted a special file) is a clean REFUSAL, not an
  // uncaught throw out of verifyCard (round 16).
  let treeAfter;
  try { treeAfter = freeze(); }
  catch (e) { return { pass: false, detail: { testOutput: `could not re-snapshot the candidate after acceptance — refusing: ${e.message}` } }; }
  if (treeBefore !== treeAfter) {
    return { pass: false, detail: { testOutput: 'acceptance changed the candidate tree — refusing: a test must not rewrite or erase the patch' } };
  }
  // Destructive-change guard on the frozen tree (baseRef → treeBefore, so untracked additions
  // count). --no-ext-diff --no-textconv so a planted `diff.external`/`textconv` can't execute in
  // the daemon during our diff, and fsmonitor/hooks disabled (round 15).
  const D = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'diff', '--no-ext-diff', '--no-textconv'];
  const stat = git(clonePath, ...D, '--shortstat', ref, treeBefore, '--').trim();
  if (suspiciousDeletion(card.goal, stat)) {
    return { pass: false, detail: { testOutput: `test passed but the diff is net-negative for a build goal — refusing (${stat})` } };
  }
  const reason = destructiveDiffReason(card.goal,
    git(clonePath, ...D, '--numstat', ref, treeBefore, '--').trim(),
    git(clonePath, ...D, '--name-status', ref, treeBefore, '--').trim());
  if (reason) return { pass: false, detail: { testOutput: `test passed but the change looks destructive — refusing (${reason})` } };
  // Return the frozen tree OID so the caller ships THIS exact verified tree via hook-free plumbing
  // (commit-tree), not a fresh checkout/commit that a planted post-checkout hook could mutate (round 13).
  return { pass: true, detail: { testOutput: 'acceptance passed (exit 0)' }, tree: treeBefore };
}

// Cheapest guard: did the working tree actually change vs the base commit the session
// started from? An empty patch fails fast without spending a full acceptance-test run.
export function patchApplied(clonePath, baseRef) {
  // Run status/diff STERILE (fsmonitor/hooks off, no ext-diff/textconv) so a candidate config
  // can't execute a helper in the daemon before verification is even reached (round 16 b).
  const s = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
  const out = execFileSync('git', [...s, 'status', '--porcelain'], { cwd: clonePath }).toString().trim();
  if (out) return true;
  const diff = execFileSync('git', [...s, 'diff', '--no-ext-diff', '--no-textconv', '--stat', `${baseRef}..HEAD`], { cwd: clonePath }).toString().trim();
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
// Test/spec files whose deletion is almost always "make it pass by removing the test". Covers
// dir-based (test/, __tests__/), suffix (.test.js, _test.go, -test.js), and both prefix forms
// (test_parser.py, test-parser.mjs) plus root-level (test.js, tests.js) — the actual discovery
// patterns of the runners we support.
const TESTISH = /(^|\/)(tests?|spec|__tests__)\/|(^|\/)test[_-][^/]+\.[a-z]+$|[._-](test|spec)\.[a-z]+$|(^|\/)conftest\.py$|(^|\/)tests?\.[a-z]+$/i;

// Stronger destructive-change guard: cross-references per-file deltas (`--numstat`) with file
// operations (`--name-status`), not just shortstat totals. A non-"build" goal that guts a file,
// a padded net-positive diff that deletes a test, deletions split across files, a test renamed
// out of discovery, or a large BINARY asset deletion all fail (round 6 #3 / round 7-8). Returns
// a reason or null.
export function destructiveDiffReason(goal, numstat = '', nameStatus = '') {
  const g = String(goal);
  const hasDeletion = DELETION_GOAL.test(g);
  const hasBuildOrFix = BUILD_GOAL.test(g) || /\b(fix(ed|es|ing)?|repair(ed|s|ing)?|resolv(e|ed|es|ing)|correct|patch|debug|refactor(ed|s|ing)?|rework(ed|s|ing)?|updat(e|ed|es|ing)|improv(e|ed|es|ing)|rewrite|rewrote|rewriting|modernize|migrate)\b/i.test(g);
  // ONLY a pure deletion goal (deletion words, no build/fix intent) disables the size/binary
  // guards — a MIXED goal like "fix parser and remove a debug log" must not (round 9/10 High).
  const pureDeletionGoal = hasDeletion && !hasBuildOrFix;
  // A test deletion is exempt only with EXPLICIT test-removal intent: a deletion word leading to a
  // test word in the SAME CLAUSE — no conjunction (and/but/then/or) or punctuation between them.
  // Rejects "fix the failing parser test" (no deletion word) and "remove debug logging and fix
  // parser tests" (a clause break separates them), while allowing "remove the flaky parser test"
  // (round 9/10 High).
  const testRemovalIntent = /\b(delete|remove|drop|prune|strip|deprecate)\b(?:(?!\b(?:and|but|then|or|also|plus|while|when|so|as|to|for|after|before|because|if|although|though|yet)\b)[^.;,\n]){0,40}\b(tests?|specs?)\b/i.test(g);
  // Map each file to its numstat so we can tell a binary deletion (`-\t-`) from a text one.
  const sizes = {};
  for (const l of String(numstat).split('\n')) {
    const [add, del, file] = l.split('\t');
    if (file) sizes[file] = { add, del, binary: add === '-' || del === '-' };
  }
  for (const l of String(nameStatus).split('\n')) {
    const del = l.match(/^D\t(.+)$/);
    if (del) {
      if (TESTISH.test(del[1]) && !testRemovalIntent) return `deletes test file ${del[1]}`;
      if (sizes[del[1]]?.binary && !pureDeletionGoal) return `deletes binary asset ${del[1]}`;   // size hidden in numstat
    }
    const ren = l.match(/^R\d*\t(.+)\t(.+)$/);
    if (ren && TESTISH.test(ren[1]) && !TESTISH.test(ren[2]) && !testRemovalIntent) return `renames test ${ren[1]} out of test discovery`;
  }
  if (pureDeletionGoal) return null;   // ONLY a pure deletion goal skips the size checks below
  // Per-file gutting (>=100 catches exactly-100) OR aggregate net deletion across many files.
  let aggNeg = 0;
  for (const f of Object.keys(sizes)) {
    const { add, del } = sizes[f];
    if (!/^\d+$/.test(add) || !/^\d+$/.test(del)) continue;   // binary handled above
    const net = Number(del) - Number(add);
    if (net >= 100) return `${f} lost ${net} net lines`;
    if (net > 0) aggNeg += net;
  }
  if (aggNeg >= 150) return `net deletion of ${aggNeg} lines across files`;
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
