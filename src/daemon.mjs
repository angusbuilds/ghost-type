// src/daemon.mjs
// The arm/disarm lifecycle and the safety machinery around an unattended night: AC/disk
// arm checks, a heartbeat so "the machine slept, the ghost never ran" is a visible outcome
// (not silence), crash reconciliation, and the worktree reaper. All shell-outs are injected
// so this is fully testable offline.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { STATE_DIR, WORK_DIR, readJson, writeJson, ensureState, log } from './lib.mjs';

export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const HEARTBEAT_FILE = path.join(STATE_DIR, 'heartbeat');
const HEARTBEAT_STALE_MS = 5 * 60 * 1000; // > 2 heartbeat intervals

export function readState() { return readJson(STATE_FILE, { status: 'off', sendoff: null, queue: [], armedAt: null }); }
export function writeState(s) { writeJson(STATE_FILE, s); }

// --- real probes (overridable in tests) ---
export function realOnBattery() {
  try { return /Battery Power/.test(execFileSync('pmset', ['-g', 'batt']).toString()); } catch { return false; }
}
export function realFreeDiskGB(dir = WORK_DIR) {
  try {
    const base = fs.existsSync(dir) ? dir : path.dirname(dir);
    const out = execFileSync('df', ['-k', base]).toString().trim().split('\n').pop().split(/\s+/);
    return Math.floor(Number(out[3]) / 1024 / 1024); // KB avail → GB
  } catch { return Infinity; }
}
function safeList(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

// Refuse to arm on battery or low disk — the two silent-death causes.
export function armChecks({ onBattery = realOnBattery, freeDiskGB = realFreeDiskGB } = {}) {
  const warnings = [];
  let ok = true;
  if (onBattery()) { warnings.push('on battery — plug into AC or the machine will sleep and the ghost never runs'); ok = false; }
  const gb = freeDiskGB();
  if (gb < 20) { warnings.push(`low disk: ${gb}GB free (< 20GB) — clones may fail`); ok = false; }
  return { ok, warnings, freeDiskGB: gb };
}

// Hold idle/display/system sleep off while armed (no sudo needed for idle sleep).
export function startCaffeinate({ spawner = spawn } = {}) {
  try { return spawner('caffeinate', ['-imds'], { detached: false, stdio: 'ignore' }); } catch { return null; }
}
export function stopCaffeinate(child) { try { child?.kill(); } catch { /* already gone */ } }

export function writeHeartbeat(now) { ensureState(); fs.writeFileSync(HEARTBEAT_FILE, String(now ?? Date.now())); }
export function heartbeatGapMs(now) {
  try { return (now ?? Date.now()) - Number(fs.readFileSync(HEARTBEAT_FILE, 'utf8')); }
  catch { return Infinity; }
}
export function machineSlept(now) { return heartbeatGapMs(now) > HEARTBEAT_STALE_MS; }

// After an unclean shutdown, any clone dir left under WORK_DIR is orphaned work. Report it
// so the caller can park-with-note or resume, and never wedge the next night on a stale dir.
export function reconcile({ workDir = WORK_DIR, list = safeList, activeBranches = [] } = {}) {
  const present = list(workDir);
  const orphans = present.filter(name => !activeBranches.map(b => b.replace(/[^\w.-]/g, '_')).includes(name));
  if (orphans.length) log({ evt: 'reconcile-orphans', orphans });
  return orphans;
}

// Prune clones not in `keep`. Disk-checked by the caller before each clone; this cleans up.
export function reap({ workDir = WORK_DIR, keep = [], list = safeList, rm = (p) => fs.rmSync(p, { recursive: true, force: true }) } = {}) {
  const removed = [];
  // Canonicalize the root so a SYMLINKED work dir can't let the reaper delete into the
  // symlink's external target (Codex re-audit #8).
  let rootReal; try { rootReal = fs.realpathSync(workDir); } catch { rootReal = path.resolve(workDir); }
  const rootSep = rootReal + path.sep;
  for (const name of list(workDir)) {
    if (keep.includes(name)) continue;
    const target = path.resolve(rootReal, name);
    // Containment: only a direct child of the canonical work dir.
    if (!target.startsWith(rootSep) || path.dirname(target) !== rootReal) continue;
    try { rm(target); removed.push(name); } catch { /* skip locked */ }
  }
  if (removed.length) log({ evt: 'reap', removed });
  return removed;
}

export function arm({ sendoff, project, checks = armChecks } = {}) {
  const c = checks();
  const state = readState();
  state.status = c.ok ? 'armed' : 'blocked';
  state.sendoff = sendoff || null;
  state.project = project || null;
  state.armedAt = new Date().toISOString();
  state.warnings = c.warnings;
  writeState(state);
  return { state, checks: c };
}

export function disarm() {
  const state = readState();
  state.status = 'off';
  state.disarmedAt = new Date().toISOString();
  writeState(state);
  return state;
}
