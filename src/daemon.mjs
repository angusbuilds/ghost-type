// src/daemon.mjs
// The arm/disarm lifecycle and the safety machinery around an unattended night: AC/disk
// arm checks, a heartbeat so "the machine slept, the ghost never ran" is a visible outcome
// (not silence), crash reconciliation, and the worktree reaper. All shell-outs are injected
// so this is fully testable offline.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { STATE_DIR, WORK_DIR, readJson, writeJson, ensureState, log } from './lib.mjs';
import { assertNoSymlinkAncestor } from './clone.mjs';

export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const HEARTBEAT_FILE = path.join(STATE_DIR, 'heartbeat');
const HEARTBEAT_STALE_MS = 5 * 60 * 1000; // > 2 heartbeat intervals

export function readState() { return readJson(STATE_FILE, { status: 'off', sendoff: null, queue: [], armedAt: null }); }
export function writeState(s) { writeJson(STATE_FILE, s); }

// --- real probes (overridable in tests) ---
// Both return `null` on an unreadable probe — an UNKNOWN safety state, which armChecks
// refuses. A failed probe used to read as "safe" (not-on-battery / infinite disk), letting
// the ghost run unattended with no validated power or headroom (round 4 #9).
export function realOnBattery() {
  try {
    const out = execFileSync('pmset', ['-g', 'batt']).toString();
    if (/Battery Power/.test(out)) return true;
    if (/AC Power/.test(out)) return false;
    return null;   // unrecognized pmset output → unknown power state → armChecks refuses (round 5 M2)
  } catch { return null; }
}
export function realFreeDiskGB(dir = WORK_DIR) {
  try {
    const base = fs.existsSync(dir) ? dir : path.dirname(dir);
    const out = execFileSync('df', ['-k', base]).toString().trim().split('\n').pop().split(/\s+/);
    const gb = Math.floor(Number(out[3]) / 1024 / 1024); // KB avail → GB
    return Number.isFinite(gb) ? gb : null;              // malformed df row → unknown
  } catch { return null; }
}
function safeList(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

// Count (and roughly size) the `.crashed-*` clones quarantined in the work dir. These are
// preserved forever by design (clone.mjs never deletes crashed work), so `ghost doctor` reports
// the backlog and its disk footprint — the owner reviews and clears them by hand. Size is a
// best-effort `du`; a du failure still yields the actionable count. Returns null (→ doctor shows
// "could not read the work dir") on an unreadable dir — read directly here rather than via
// safeList, whose swallow-to-[] would falsely report "no crashed clones held" (round 30 audit #1).
export function realQuarantineBacklog(dir = WORK_DIR) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return null; }   // unreadable → unknown, NOT clean
  // Match the end-anchored quarantine suffix on real directories: `.crashed-<ms>` with an OPTIONAL
  // `-<6 hex>` (current clone.mjs appends the hex; older versions did not — both are real crashed
  // clones). This excludes a like-named file or a legit clone that merely contains the substring,
  // without hiding old-format quarantines (round 30 audit #2, refined to cover both naming eras).
  const names = entries.filter(e => e.isDirectory() && /\.crashed-\d+(-[0-9a-f]{6})?$/.test(e.name)).map(e => e.name);
  if (names.length === 0) return { count: 0, sizeMB: 0 };
  const paths = names.map(n => path.join(dir, n));
  let sizeMB = null;
  try {
    let totalKb = 0;
    // Batch under ARG_MAX, and `-s` so du summarizes each clone rather than emitting every nested
    // object dir (which can overrun the output buffer). Any batch that fails or parses non-finite
    // drops size to null — never a silent undercount (round 30 audit #3).
    for (let i = 0; i < paths.length; i += 256) {
      const out = execFileSync('du', ['-sck', ...paths.slice(i, i + 256)]).toString().trim().split('\n');
      const kb = Number(out[out.length - 1].split(/\s+/)[0]);   // batch grand-total row from `du -c`
      if (!Number.isFinite(kb)) throw new Error('unparseable du total');
      totalKb += kb;
    }
    sizeMB = Math.round(totalKb / 1024);
  } catch { /* size is best-effort — the count is the actionable part */ }
  return { count: names.length, sizeMB };
}

// Refuse to arm on battery, low disk, OR an unknown probe result — the silent-death causes.
export function armChecks({ onBattery = realOnBattery, freeDiskGB = realFreeDiskGB } = {}) {
  const warnings = [];
  let ok = true;
  const batt = onBattery();
  if (batt !== false) {                                  // true OR null(unknown) → refuse
    warnings.push(batt === null ? 'could not read power state — refusing to arm (fail-closed)'
                                : 'on battery — plug into AC or the machine will sleep and the ghost never runs');
    ok = false;
  }
  const gb = freeDiskGB();
  if (typeof gb !== 'number' || !Number.isFinite(gb)) {  // null/NaN/Infinity → refuse
    warnings.push('could not read free disk — refusing to arm (fail-closed)');
    ok = false;
  } else if (gb < 20) {
    warnings.push(`low disk: ${gb}GB free (< 20GB) — clones may fail`);
    ok = false;
  }
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
  // Refuse if the work root OR ANY of its ancestors within HOME is a symlink — a symlinked
  // `~/.ghosttype` makes WORK_DIR look like a plain dir while the recursive delete escapes to
  // the link's external target. The reaper must share makeClone's guard (round 6 #2).
  try { assertNoSymlinkAncestor(workDir); }
  catch (e) { log({ evt: 'reap-refused-symlink-ancestor', workDir, why: e.message }); return removed; }
  const root = path.resolve(workDir);
  const rootSep = root + path.sep;
  for (const name of list(workDir)) {
    if (keep.includes(name)) continue;
    const target = path.resolve(root, name);
    // Containment: only a direct child of the work dir.
    if (!target.startsWith(rootSep) || path.dirname(target) !== root) continue;
    try { rm(target); removed.push(name); } catch { /* skip locked */ }
  }
  if (removed.length) log({ evt: 'reap', removed });
  return removed;
}

// Remove ONE completed clone. Once a card's verified commit is fetched back to the source repo
// (OID-pinned), the clone is redundant — reaping it reclaims disk so successful clones don't
// accumulate every night until the arm check blocks future runs (round 18 #9). reconcile/reap
// still PRESERVE parked/crashed clones (unfinished work); only a confirmed-complete clone is reaped
// here. Same symlink-ancestor + containment guards as reap; never throws.
export function reapClone(name, { workDir = WORK_DIR, rm = (p) => fs.rmSync(p, { recursive: true, force: true }) } = {}) {
  try { assertNoSymlinkAncestor(workDir); }
  catch (e) { log({ evt: 'reap-clone-refused-symlink-ancestor', workDir, why: e.message }); return false; }
  const root = path.resolve(workDir);
  const target = path.resolve(root, name);
  if (!target.startsWith(root + path.sep) || path.dirname(target) !== root) return false;   // only a direct child
  try { rm(target); log({ evt: 'reap-clone', name }); return true; } catch { return false; }
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
