// src/clone.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { WORK_DIR, ensureState, log } from './lib.mjs';

export function validateClonePath(p) {
  const resolved = path.resolve(p);
  const root = path.resolve(WORK_DIR) + path.sep;
  if (!resolved.startsWith(root)) throw new Error(`clone path outside WORK_DIR: ${resolved}`);
}

// Refuse if any ancestor of WORK_DIR *within the user's home* is a symlink — an attacker-
// planted `~/.ghosttype` link would redirect the recursive delete below. We stop at HOME
// deliberately: OS-level symlinks above it (/var, /tmp on macOS) are not in our threat model
// and aren't attacker-controlled (round 5 L1).
export function assertNoSymlinkAncestor(dir, stopAt = os.homedir()) {
  const stop = path.resolve(stopAt);
  let p = path.resolve(dir);
  while (true) {
    // Always check the CURRENT component (so a directly-symlinked target is caught wherever it
    // lives); then walk up, but only through ancestors inside the guarded root — OS-level
    // symlinks above HOME (/var, /tmp on macOS) are not attacker-controlled (round 5 L1 / round 6 #2).
    try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`symlinked path component: ${p}`); }
    catch (e) { if (/symlinked path component/.test(e.message)) throw e; /* ENOENT ancestor → fine */ }
    const parent = path.dirname(p);
    if (parent === p) break;                 // reached filesystem root
    if (!parent.startsWith(stop)) break;     // ancestor left the guarded root → stop
    p = parent;
  }
}

// Fully isolated clone: --no-hardlinks copies the object store instead of hardlinking it,
// so an agent that modifies (or chmods) a clone object can never corrupt the SOURCE repo's
// objects (Codex H7). --local keeps it a fast filesystem copy; the clone has its own
// .git/config + hooks. First act: remove origin so push/gh/deploy have nowhere to go.
export function makeClone(repoPath, taskId) {
  ensureState();
  // Refuse a symlinked work root OR any symlinked ancestor — else the recursive delete below
  // could follow it into an external target (round 4 #2 + round 5 L1).
  assertNoSymlinkAncestor(WORK_DIR);
  const clonePath = path.join(WORK_DIR, taskId);
  validateClonePath(clonePath);
  // Reject a source that overlaps the work dir — canonicalized so a symlink alias to the
  // work dir can't slip past a lexical check and let the source be deleted (Codex re-audit #4).
  const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const src = realOr(path.resolve(repoPath)) + path.sep;
  const work = realOr(WORK_DIR) + path.sep;
  if (src.startsWith(work) || work.startsWith(src)) throw new Error(`clone source overlaps the work dir: ${repoPath}`);
  // Don't silently destroy an existing clone at this path — a same-night restart regenerates
  // the same deterministic branch/dir, and that clone holds the crashed run's work. Quarantine
  // it (reconcile then treats the renamed dir as an orphan and preserves it) instead of deleting
  // (round 6 #4). Only fall back to removal if the rename itself fails.
  if (fs.existsSync(clonePath)) {
    // Collision-resistant name (ts + random) so two clones in the same ms don't clash; and if the
    // rename FAILS we throw rather than delete — never destroy crashed work as a fallback (round 7 High#2).
    const quarantine = `${clonePath}.crashed-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    try { fs.renameSync(clonePath, quarantine); log({ evt: 'clone-quarantined', from: clonePath, to: quarantine }); }
    catch (e) { throw new Error(`existing clone at ${clonePath} could not be quarantined — refusing to delete unsaved work: ${e.message}`); }
  }
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', path.resolve(repoPath), clonePath]);
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: clonePath });
  return clonePath;
}

// Pull a completed branch back into the real repo WITHOUT pushing: fetch from the
// clone into the source. The real repo is only ever a fetch destination, never a push target.
export function fetchBranchBack(repoPath, clonePath, branch) {
  execFileSync('git', ['fetch', '--quiet', path.resolve(clonePath), `${branch}:${branch}`], { cwd: path.resolve(repoPath) });
}
