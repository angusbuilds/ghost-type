// src/lib.mjs
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const HOME = os.homedir();
export const GHOST_HOME = path.join(HOME, '.ghosttype');
export const STATE_DIR = GHOST_HOME;
export const WORK_DIR = path.join(GHOST_HOME, 'work');
export const LOG_FILE = path.join(STATE_DIR, 'log.jsonl');
export const CLAUDE_BIN = process.env.GHOST_CLAUDE_BIN || path.join(HOME, '.local/bin/claude');
export const CODEX_BIN = process.env.GHOST_CODEX_BIN || path.join(HOME, '.local/bin/codex');

export function ensureState() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

// Read JSON; on a corrupt (non-empty but unparseable) file, preserve it as .corrupt so a
// crash-truncated state file isn't silently overwritten as if it were "no state" (Codex M1).
export function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(raw); }
  catch {
    if (raw.trim()) { try { fs.writeFileSync(`${file}.corrupt-${Date.now()}`, raw); } catch { /* best effort */ } }
    return fallback;
  }
}

// Atomic write: an EXCLUSIVE (O_EXCL) randomly-named temp + flush + rename, so a crash
// mid-write can't leave a truncated file, a pre-planted symlink at the temp path can't be
// followed, and the destination's mode is preserved (Codex M1 + re-audit #7).
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file → keep 0600 */ }
  const tmp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', mode);   // O_CREAT|O_EXCL|O_WRONLY — never follows a symlink
  try {
    try {
      fs.fchmodSync(fd, mode);               // the open() mode is umask-filtered; force it (re-audit #7)
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    // ANY failure after open — fchmod/write/fsync/close/rename — must not leak the temp (round 4 #13).
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

// A held lock older than this is presumed abandoned by a crashed holder. Always compared
// against this fixed ceiling, never against the WAITING caller's own attempts*waitMs — tying
// reclaim to the waiter's own (possibly short, or simply exhausted-sooner) budget let it
// delete a lock its rightful holder still legitimately held, e.g. mid a slow read-modify-
// write (round-37 audit #3).
const STALE_LOCK_MS = 5000;

// Best-effort exclusive lock for the rare cross-PROCESS read-modify-write on a shared file — two
// `ghost haunt` CLI invocations racing on haunted.json each read-then-write the whole list, so the
// second writer clobbers the first (round 35). O_EXCL create is the lock; spin briefly; on timeout
// PROCEED anyway — the guarded state is non-critical UI bookkeeping, so a rare lost update beats a hung
// command. A lock older than STALE_LOCK_MS is reclaimed so a crashed holder can't wedge it forever.
// writeJson already makes each individual write atomic; this serializes the RMW around it.
//
// `strict: true` is the opt-in for callers whose correctness claim can't tolerate "proceed
// anyway" — e.g. claimDrive's one-live-drive-per-pane guarantee. Once the normal spin budget
// (attempts*waitMs) is exhausted without acquiring the lock, a strict caller keeps waiting
// (still subject to the same STALE_LOCK_MS reclaim) instead of running fn() unguarded,
// concurrently with whoever actually holds it.
export function withFileLock(target, fn, { attempts = 40, waitMs = 15, staleMs = STALE_LOCK_MS, strict = false } = {}) {
  const lock = `${target}.lock`;
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch { /* dir exists */ }
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } };
  // Ownership token — this process's pid plus a random suffix — written into the lock file
  // the instant it's created. File age alone can't tell a crashed holder from one that's
  // merely slow (e.g. mid a long fn() — see the STALE_LOCK_MS comment above), and stealing a
  // still-live holder's lock let two callers run fn() concurrently, exactly what strict mode
  // exists to prevent (round-40 audit #1). The token fixes both ends of that: staleness
  // reclaim now checks whether the CURRENT holder's pid is actually still alive before ever
  // deleting its lock, and release only ever deletes a lock file whose content still IS the
  // token this process wrote — never whatever happens to be sitting at the lock path.
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  const isAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }   // exists but owned by another user — treat as alive
  };
  // Reclaim only a lock that is BOTH old enough AND whose recorded holder pid is no longer
  // running — age alone (the old check) treated "slow" and "crashed" as indistinguishable.
  const reclaimIfAbandoned = () => {
    let mtimeMs;
    try { mtimeMs = fs.statSync(lock).mtimeMs; } catch { return; }        // gone/raced
    if (Date.now() - mtimeMs <= staleMs) return;
    let content;
    try { content = fs.readFileSync(lock, 'utf8'); } catch { return; }    // gone/raced
    const holderPid = Number(content.split(':')[0]);
    if (isAlive(holderPid)) return;                                      // slow, not crashed — never steal
    // Compare-before-delete: only remove the file if its content hasn't changed since we
    // inspected it, so a lock the real holder just released cleanly (or that a concurrent
    // reclaimer already replaced) can't be deleted out from under its new, legitimate owner.
    try { if (fs.readFileSync(lock, 'utf8') === content) fs.rmSync(lock, { force: true }); } catch { /* gone/raced */ }
  };
  const tryAcquire = () => {
    try {
      const fd = fs.openSync(lock, 'wx');   // wx = O_CREAT|O_EXCL — fails if held
      try { fs.writeFileSync(fd, token); } finally { fs.closeSync(fd); }
      return true;
    } catch {
      reclaimIfAbandoned();
      return false;
    }
  };
  let held = false;
  for (let i = 0; i < attempts && !held; i++) {
    held = tryAcquire();
    if (!held) sleep(waitMs);
  }
  while (strict && !held) { held = tryAcquire(); if (!held) sleep(waitMs); }
  try {
    const r = fn();
    // finally below releases the lock the moment fn RETURNS — an async callback would run
    // its awaited body completely unlocked (round-44 #12). Reject loudly.
    if (r && typeof r.then === 'function') throw new Error('withFileLock callbacks must be synchronous — an async fn would run after the lock is released');
    return r;
  }
  finally {
    if (held) {
      try { if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true }); } catch { /* best effort */ }
    }
  }
}

export function log(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging must never throw */ }
}

// An engine call FAILED if it exited nonzero OR returned a STRUCTURED provider error — Claude reports
// a rate/usage limit as the contradictory subtype:success + is_error:true shape with exit 0 (round 28
// #3). Its text must NEVER be reused as a next-prompt, candidate, plan, diagnosis, or voice profile;
// an exitCode-only check leaks the limit message into all of those (round 28 #3-variant, systematized).
export function engineFailed(r) {
  // A result is a clean success ONLY if subtype==='success' with no is_error (matching watcher's
  // classifyOutcome). A structured result whose subtype is present but NOT 'success' (e.g. 'error',
  // 'error_max_turns') is a failure even with exit 0 and no is_error flag — the shape the CLIs actually
  // emit for a rate/usage limit, which must never leak into a next-prompt/plan/voice (round 32 audit).
  return Boolean(r && ((r.exitCode != null && r.exitCode !== 0) || r.result?.is_error === true
    || (r.result?.subtype != null && r.result.subtype !== 'success')));
}

// Truncate to a byte ceiling, appending a visible marker when cut.
export function byteCap(text, maxBytes) {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.byteLength <= maxBytes) return String(text);
  const head = buf.subarray(0, maxBytes).toString('utf8');
  const dropped = buf.byteLength - maxBytes;
  return `${head}\n[truncated ${dropped} bytes]`;
}
