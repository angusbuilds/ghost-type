// src/drives.mjs
// Drive registry: which panes have a LIVE `ghost drive` process. The drive CLI records
// itself here on start and deregisters on exit, so "driving" in the menu bar means a real
// process — not a wish. Liveness is verified against the process table (pid reuse would
// otherwise make a recycled pid look like our drive), and the checks are injected so all
// of this is testable offline. State persists under ~/.ghosttype/drives.json.
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { STATE_DIR, readJson, writeJson, withFileLock } from './lib.mjs';

export const DRIVES_FILE = path.join(STATE_DIR, 'drives.json');

export function readDrives(file = DRIVES_FILE) {
  const v = readJson(file, {});
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

export function recordDrive(paneId, { pid, goal, engine } = {}, { file = DRIVES_FILE, now = () => new Date().toISOString() } = {}) {
  return withFileLock(file, () => {
    const cur = readDrives(file);
    cur[paneId] = { pid, goal, engine, startedAt: now() };
    writeJson(file, cur);
    return cur;
  });
}

// ps round-trips (one per registry entry) must not run INSIDE the lock — withFileLock
// reclaims a lock older than staleMs (5s by default, round-37 #3), and enough entries can
// make the ps loop outlast that window, letting a second process reclaim the lock
// mid-read-modify-write and corrupt it. haunt.mjs keeps its tmux calls outside its lock for
// the same reason. So
// the aliveness check runs on a snapshot taken BEFORE the lock; inside the lock we re-read
// the file and only trust the snapshot's verdict for entries that haven't changed since —
// an entry that changed under us (a racing claim/clear) gets one fresh ps call instead of a
// stale verdict, keeping the lock's held ps work bounded regardless of registry size.
function snapshotAlive(file, isAlive) {
  const snapshot = readDrives(file);
  const alive = {};
  for (const [paneId, entry] of Object.entries(snapshot)) {
    if (isAlive({ ...entry, paneId })) alive[paneId] = true;
  }
  return { snapshot, alive };
}

function pruneWithSnapshot(cur, snapshot, aliveSnapshot, isAlive) {
  const live = {};
  let pruned = false;
  for (const [paneId, entry] of Object.entries(cur)) {
    const unchanged = snapshot[paneId] && JSON.stringify(snapshot[paneId]) === JSON.stringify(entry);
    const alive = unchanged ? Boolean(aliveSnapshot[paneId]) : isAlive({ ...entry, paneId });
    if (alive) live[paneId] = entry;
    else pruned = true;
  }
  return { live, pruned };
}

// The already-driving guard and the registration must be ONE atomic operation, or two
// `ghost drive` invocations racing on the same pane can both read "free" before either has
// written — recordDrive alone has no such check (by design: it's the low-level primitive
// "last write wins"), which is exactly what let two loops start typing into one pane
// (round-36 audit #5/#9/#14/#17). Also prunes dead entries file-wide under the same lock,
// same self-heal liveDrives() does, so a stray SIGKILLed drive elsewhere doesn't linger —
// including on the REJECT path, where the prune must still be written even though this
// pane's own claim didn't go through.
//
// strict: true — withFileLock's default "proceed anyway on timeout" is fine for haunted.json's
// best-effort bookkeeping, but claimDrive's one-live-drive-per-pane guarantee can't tolerate
// two racing claims ever running their critical section unguarded at once (round-37 audit #3).
export function claimDrive(paneId, { pid, goal, engine } = {}, { file = DRIVES_FILE, isAlive = realDriveAlive, now = () => new Date().toISOString() } = {}) {
  const { snapshot, alive: aliveSnapshot } = snapshotAlive(file, isAlive);
  return withFileLock(file, () => {
    const cur = readDrives(file);
    const { live } = pruneWithSnapshot(cur, snapshot, aliveSnapshot, isAlive);
    if (live[paneId]) {
      writeJson(file, live);
      return { claimed: false, existing: live[paneId] };
    }
    live[paneId] = { pid, goal, engine, startedAt: now() };
    writeJson(file, live);
    return { claimed: true };
  }, { strict: true });
}

// pid-guarded when given: a dead drive's late cleanup must not deregister a newer drive
// that took over the same pane.
//
// strict: true — same reason as claimDrive (round-37 #3): the non-strict "proceed anyway on
// timeout" fallback let clearDrive's read-modify-write run completely unguarded, from a
// stale read, while another process (e.g. a concurrent claimDrive) was still mid-critical-
// section — racing writes could then silently erase that process's just-registered claim
// (round-38 #1).
export function clearDrive(paneId, { file = DRIVES_FILE, pid } = {}) {
  return withFileLock(file, () => {
    const cur = readDrives(file);
    if (paneId in cur && (pid === undefined || cur[paneId].pid === pid)) {
      delete cur[paneId];
      writeJson(file, cur);
    }
    return cur;
  }, { strict: true });
}

// `ghost drive`'s own parseArgs accepts these value-flags in ANY position relative to the
// positionals (bin/ghost.mjs), so the pane id is not reliably the token right after 'drive'.
const DRIVE_VALUE_FLAGS = new Set(['--engine', '--max']);

// A registry entry is live only if its pid exists AND that process is still OUR drive of
// THIS pane — `ps` argv must name both. Fails closed: unreadable → not alive.
export function realDriveAlive(entry) {
  if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0) return false;
  try {
    const cmd = execFileSync('ps', ['-p', String(entry.pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    // paneId must be the FIRST token after 'drive' that isn't a recognized flag or its
    // value — not merely present as a WHOLE token anywhere on the line, and not assumed to
    // sit at a fixed +1 offset. `ghost drive <paneId> <goal...>` joins goal straight from
    // free-text positionals, so a stale entry's pid can be reused by an unrelated, real
    // `ghost drive <otherPane> "<goal>"` process whose goal legitimately contains this
    // paneId as its own standalone token — a whole-token scan of the whole line still
    // matches that, just at the wrong argv slot (round-37 audit #1; round-36 #13/#18 only
    // fixed the bare-SUBSTRING variant, e.g. "%1" inside "%12"). And a real invocation like
    // `ghost drive --engine codex %7 "goal"` puts a flag+value BEFORE the pane id, so a
    // fixed +1 offset misreads a genuinely live drive as dead (round-38 audit #4).
    return driveArgvMatches(cmd, entry.paneId);
  } catch {
    // The identity probe failed on a process that EXISTS — unknown, not dead (round-44 #6).
    // But a pid that doesn't exist at all is definitive death: kill(pid, 0) throws ESRCH.
    try { process.kill(entry.pid, 0); return true; } catch { return false; }
  }
}

// Identity: the process must be OUR entrypoint (a ghost.mjs token), with this exact pane
// as the first post-flag token after 'drive'. "drive %7" appearing in an unrelated argv
// is not identity (codex round-44 #5).
export function driveArgvMatches(cmd, paneId) {
  const tokens = String(cmd).trim().split(/\s+/);
  if (!tokens.some(t => /(^|\/)ghost\.mjs$/.test(t))) return false;
  const driveIdx = tokens.indexOf('drive');
  if (driveIdx === -1) return false;
  let i = driveIdx + 1;
  while (i < tokens.length && DRIVE_VALUE_FLAGS.has(tokens[i])) i += 2;
  return i < tokens.length && tokens[i] === paneId;
}

// Live entries only — and dead ones are healed out of the file (a SIGKILLed drive never
// runs its own cleanup, so the registry must self-repair on read).
//
// strict: true — same reason as claimDrive/clearDrive (round-37 #3, round-38 #1): the
// non-strict "proceed anyway on timeout" fallback let this read-modify-write run completely
// unguarded, from a stale read, while another process (e.g. a concurrent claimDrive) was
// still mid-critical-section — racing writes could then silently erase that process's
// just-registered claim. liveDrives is polled every 4s by the menu bar and called internally
// by stopDrive, so it hits this window often; it was simply missed when the fix was applied
// to its two siblings on the same file (round-39 #1).
export function liveDrives({ file = DRIVES_FILE, isAlive = realDriveAlive } = {}) {
  // An isAlive that THROWS is an unknown, not a death — pruning on it would let a racing
  // claim start a second drive on a pane whose incumbent is fine (round-44 #6).
  const safeAlive = (e) => { try { return isAlive(e); } catch { return true; } };
  const { snapshot, alive: aliveSnapshot } = snapshotAlive(file, safeAlive);
  // A corrupt registry parses as {} but stays corrupt on disk forever, minting a .corrupt
  // sidecar on every 4s poll (round-44 #10) — normalize it under the same lock.
  let invalid = false;
  try { const t = fs.readFileSync(file, 'utf8'); if (t.trim()) JSON.parse(t); }
  catch (e) { invalid = e.code !== 'ENOENT'; }
  return withFileLock(file, () => {
    const cur = readDrives(file);
    const { live, pruned } = pruneWithSnapshot(cur, snapshot, aliveSnapshot, safeAlive);
    if (pruned || invalid) writeJson(file, live);
    return live;
  }, { strict: true });
}

// SIGINT the drive's own process — its signal handler unhaunts the pane and deregisters,
// so stopping goes through the same cleanup path as ctrl-c in a terminal.
//
// expectedPid, when given, must match the verified-live pid exactly before anything is
// signaled — the caller (the menu-bar app at Quit) is asserting "kill only the drive I
// spawned," and a pane can be reused by an unrelated drive (CLI-started, or a newer
// app-spawned one) in the time between the app last seeing it and Quit firing.
export function stopDrive(paneId, { file = DRIVES_FILE, isAlive = realDriveAlive, kill = process.kill, expectedPid } = {}) {
  const live = liveDrives({ file, isAlive });
  const entry = live[paneId];
  if (!entry) return { stopped: false };
  if (expectedPid !== undefined && entry.pid !== expectedPid) return { stopped: false, mismatch: true };
  try { kill(entry.pid, 'SIGINT'); } catch { return { stopped: false }; }
  return { stopped: true, pid: entry.pid };
}
