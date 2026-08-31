// test/drives-cli.test.mjs — the drive registry through the real entry point, as the menu
// bar will use it: `drives --json` is what the app polls, `undrive` is how it stops a
// drive, and the already-driving guard is what stops two loops typing into one pane.
// The "live drive" here is a dummy node process whose argv contains ` drive %7` — real
// enough for the ps-based liveness check without spending a token or needing tmux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GHOST = fileURLToPath(new URL('../bin/ghost.mjs', import.meta.url));

// Pane ids are global to the USER's tmux server, not to $HOME — a bare `tmux` here could
// tint a real pane. A failing `tmux` shim first on PATH makes every tmux call a safe no-op.
const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-fakebin-'));
fs.writeFileSync(path.join(FAKE_BIN, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

function runGhost(args, home) {
  const env = { ...process.env, HOME: home, PATH: `${FAKE_BIN}:${process.env.PATH}` };
  const opts = { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  try { return { code: 0, out: execFileSync('node', [GHOST, ...args], opts) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

function freshHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-drives-cli-')); }

// A live process whose ps command line reads `node -e ... marker drive %7` — satisfies
// realDriveAlive's pid+argv check for pane %7.
function spawnDummyDrive() {
  const child = spawn('node', ['-e', 'setTimeout(() => {}, 30000)', 'marker', 'drive', '%7'], { stdio: 'ignore' });
  return child;
}
function seedRegistry(home, paneId, pid) {
  const dir = path.join(home, '.ghosttype');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'drives.json'),
    JSON.stringify({ [paneId]: { pid, goal: 'g', engine: 'claude', startedAt: '2026-08-30T00:00:00Z' } }));
}
function isProcessAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(cond, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise(r => setTimeout(r, 50)); }
  return cond();
}

test('`ghost drives --json` is {} on a fresh install; bare `drives` prints a human line', () => {
  const home = freshHome();
  try {
    const j = runGhost(['drives', '--json'], home);
    assert.equal(j.code, 0, j.out);
    assert.deepEqual(JSON.parse(j.out), {});
    const h = runGhost(['drives'], home);
    assert.equal(h.code, 0, h.out);
    assert.match(h.out, /not driving|no live drives/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`ghost drives --json` lists a live drive and prunes a dead one', () => {
  const home = freshHome();
  const dummy = spawnDummyDrive();
  try {
    seedRegistry(home, '%7', dummy.pid);
    const live = runGhost(['drives', '--json'], home);
    assert.equal(live.code, 0, live.out);
    assert.equal(JSON.parse(live.out)['%7'].pid, dummy.pid);

    // dead pid → pruned from output AND healed out of the file
    const home2 = freshHome();
    try {
      seedRegistry(home2, '%7', 99999999);
      const dead = runGhost(['drives', '--json'], home2);
      assert.deepEqual(JSON.parse(dead.out), {});
      const onDisk = JSON.parse(fs.readFileSync(path.join(home2, '.ghosttype', 'drives.json'), 'utf8'));
      assert.deepEqual(onDisk, {});
    } finally { fs.rmSync(home2, { recursive: true, force: true }); }
  } finally {
    dummy.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('`ghost drive` refuses a pane that already has a live drive (exit 2)', () => {
  const home = freshHome();
  const dummy = spawnDummyDrive();
  try {
    seedRegistry(home, '%7', dummy.pid);
    const r = runGhost(['drive', '%7', 'some goal'], home);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /already driving %7/);
    assert.match(r.out, /undrive/);
  } finally {
    dummy.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('`ghost undrive` SIGINTs the live drive and reports it', async () => {
  const home = freshHome();
  const dummy = spawnDummyDrive();
  try {
    seedRegistry(home, '%7', dummy.pid);
    const r = runGhost(['undrive', '%7'], home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`stopping %7 \\(pid ${dummy.pid}\\)`));
    assert.ok(await waitFor(() => !isProcessAlive(dummy.pid)), 'dummy drive should be dead after undrive');
  } finally {
    try { dummy.kill('SIGKILL'); } catch { /* already dead */ }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('`ghost undrive <pane> --pid <wrong>` refuses to kill a drive with a different pid', async () => {
  const home = freshHome();
  const dummy = spawnDummyDrive();
  try {
    seedRegistry(home, '%7', dummy.pid);
    const r = runGhost(['undrive', '%7', '--pid', String(dummy.pid + 1)], home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /%7 is being driven, but not by pid/);
    assert.ok(isProcessAlive(dummy.pid), 'the real drive must survive a pid mismatch');
  } finally {
    dummy.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('`ghost undrive <pane> --pid <right>` kills the drive whose pid matches', async () => {
  const home = freshHome();
  const dummy = spawnDummyDrive();
  try {
    seedRegistry(home, '%7', dummy.pid);
    const r = runGhost(['undrive', '%7', '--pid', String(dummy.pid)], home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`stopping %7 \\(pid ${dummy.pid}\\)`));
    assert.ok(await waitFor(() => !isProcessAlive(dummy.pid)), 'dummy drive should be dead after undrive --pid match');
  } finally {
    try { dummy.kill('SIGKILL'); } catch { /* already dead */ }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// `ghost on` trims and rejects a whitespace-only goal; `ghost drive` must too, or a pane
// gets claimed, tinted, and driven toward effectively nothing (round-38 audit #2).
test('`ghost drive <pane> "   "` (whitespace-only goal) is a usage error, not a claimed drive', () => {
  const home = freshHome();
  try {
    const r = runGhost(['drive', '%5', '   '], home);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ghost drive <pane-id>/);
    const drivesFile = path.join(home, '.ghosttype', 'drives.json');
    const drives = fs.existsSync(drivesFile) ? JSON.parse(fs.readFileSync(drivesFile, 'utf8')) : {};
    assert.deepEqual(drives, {}, 'a whitespace-only goal must never claim the pane');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`ghost undrive` on a non-driven pane says so and exits 0', () => {
  const home = freshHome();
  try {
    const r = runGhost(['undrive', '%9'], home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /%9 is not being driven/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a drive that ends (pane gone) leaves no registry or haunt residue', () => {
  const home = freshHome();
  try {
    // pane %99999 does not exist in any tmux server → hauntDrive returns pane-gone at once
    const r = runGhost(['drive', '--max', '1', '%99999', 'goal'], home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pane-gone/);
    const dir = path.join(home, '.ghosttype');
    const drives = fs.existsSync(path.join(dir, 'drives.json'))
      ? JSON.parse(fs.readFileSync(path.join(dir, 'drives.json'), 'utf8')) : {};
    const haunted = fs.existsSync(path.join(dir, 'haunted.json'))
      ? JSON.parse(fs.readFileSync(path.join(dir, 'haunted.json'), 'utf8')) : [];
    assert.deepEqual(drives, {});
    assert.deepEqual(haunted, []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// A goal typed in the GUI's free-text field is a completely plausible '--foo the bar'
// phrasing, and Model.swift packs the whole goal into a single argv element — so parseArgs
// must never reject a goal word starting with '--' as an "unknown option" once the pane id
// positional has been consumed. Both panes are nonexistent so hauntDrive takes the fast
// pane-gone exit — a real usage-error rejection is what these tests rule out.
//
// The contract is ONE rule (round-44 simplification, replacing the freeTrailingText +
// valueValidators machinery that grew across rounds 39-43 patching its own edge cases):
// flags parse only BEFORE the pane id; every token after the pane id is goal prose,
// verbatim, never parsed as an option — plus one courtesy guard: a first post-pane token
// that is EXACTLY --engine/--max is a misplaced flag typed at a shell (the GUI always sends
// the goal as a single argv element), so it fails closed with placement guidance instead of
// silently driving toward flag-shaped prose.
test('`ghost drive <pane> "--looks-like-a-flag ..."` is goal text, not a rejected option (whole-token case)', () => {
  const home = freshHome();
  try {
    const r = runGhost(['drive', '%99998', '--refactor the auth flow'], home);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /unknown option/);
    assert.match(r.out, /pane-gone/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`ghost drive <pane> fix --the bug` is goal text, not a rejected option (mid-goal word case)', () => {
  const home = freshHome();
  try {
    const r = runGhost(['drive', '%99997', 'fix', '--the', 'bug'], home);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /unknown option/);
    assert.match(r.out, /pane-gone/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`ghost drive <pane> "goal words" --max 5` (bare flag token anywhere after the pane id) fails closed with placement guidance', () => {
  // Live-caught during verification: the old-style trailing flag silently became goal text
  // AND the injection cap silently stayed at its default — worse than either honoring or
  // rejecting it. Any bare recognized flag token after the pane id is a misplaced flag.
  const home = freshHome();
  try {
    const r = runGhost(['drive', '%99995', 'cap', 'retries', '--max', '5'], home);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /flags go before the pane id/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`ghost drive <pane> "cap --max 5 retries then stop"` (quoted, single argv element) is still goal prose', () => {
  const home = freshHome();
  try {
    const r = runGhost(['drive', '%99995', 'cap --max 5 retries then stop'], home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /toward: cap --max 5 retries then stop/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`ghost drive <pane> mention the --engine codex fallback` (bare flag token mid-goal, shell-split) fails closed with placement guidance', () => {
  const home = freshHome();
  try {
    const r = runGhost(['drive', '%99993', 'mention', 'the', '--engine', 'codex', 'fallback'], home);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /flags go before the pane id/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// The courtesy guard: a bare recognized flag token right after the pane id can only come
// from shell typing with the flag in the wrong place — fail closed with placement guidance,
// never silently drive toward flag-shaped prose ("--engine codex" as a goal) and never
// silently honor a misplaced flag either.
test('`ghost drive <pane> --engine codex ...` (flag after the pane id) fails closed with placement guidance', () => {
  const home = freshHome();
  try {
    const r = runGhost(['drive', '%99996', '--engine', 'codex', 'do', 'the', 'thing'], home);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /flags go before the pane id/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`ghost drive <pane> --max out the deploy` (flag-shaped first goal word, shell-split) fails closed with placement guidance', () => {
  const home = freshHome();
  try {
    const r = runGhost(['drive', '%99992', '--max', 'out', 'the', 'deploy'], home);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /flags go before the pane id/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ...but the same words QUOTED (one argv element, exactly how the GUI always sends a goal)
// are not a bare flag token and drive as prose.
test('`ghost drive <pane> "--max out the deploy"` (quoted, single argv element) is goal prose', () => {
  const home = freshHome();
  try {
    const r = runGhost(['drive', '%99991', '--max out the deploy'], home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /toward: --max out the deploy/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Regression guard: a VALID --engine value before the pane id must still resolve as the real
// flag and correctly target the real pane (round-38 audit #4, now exercised at the CLI level).
test('`ghost drive --engine <valid-value> <pane> "<goal>"` still targets the real pane (round-38 #4 regression guard)', () => {
  const home = freshHome();
  try {
    const r = runGhost(['drive', '--engine', 'codex', '%99987', 'fix', 'the', 'thing'], home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /toward: fix the thing/, 'the pane id must be consumed as the pane, not folded into the goal');
    assert.match(r.out, /pane-gone/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// `ghost join` — the enrollment half of menu-bar driving: typed in a terminal, it wraps
// that terminal in a named tmux session so it appears in the dropdown. In tests stdio is a
// pipe, never a tty, so join must take the guidance path — it can never spawn tmux here.
test('`ghost join` inside tmux says the terminal is already driveable (exit 0)', () => {
  const home = freshHome();
  try {
    const opts = { env: { ...process.env, HOME: home, TMUX: '/tmp/fake,123,0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const out = execFileSync('node', [GHOST, 'join'], opts);
    assert.match(out, /already driveable/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('`ghost join` without a tty prints guidance instead of spawning tmux (exit 1)', () => {
  const home = freshHome();
  try {
    const env = { ...process.env, HOME: home };
    delete env.TMUX;
    const r = (() => {
      try { return { code: 0, out: execFileSync('node', [GHOST, 'join'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
      catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
    })();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /run it in a terminal/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
