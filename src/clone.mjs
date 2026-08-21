// src/clone.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { WORK_DIR, ensureState } from './lib.mjs';

export function validateClonePath(p) {
  const resolved = path.resolve(p);
  const root = path.resolve(WORK_DIR) + path.sep;
  if (!resolved.startsWith(root)) throw new Error(`clone path outside WORK_DIR: ${resolved}`);
}

// git clone --local gives an isolated clone (own .git/config + hooks), cheap because
// the object store is hardlinked when on one filesystem; the working tree is a
// separate checkout. First act: remove origin so push/gh/deploy have nowhere to go.
export function makeClone(repoPath, taskId) {
  ensureState();
  const clonePath = path.join(WORK_DIR, taskId);
  validateClonePath(clonePath);
  if (fs.existsSync(clonePath)) fs.rmSync(clonePath, { recursive: true, force: true });
  execFileSync('git', ['clone', '--local', '--quiet', path.resolve(repoPath), clonePath]);
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: clonePath });
  return clonePath;
}

// Pull a completed branch back into the real repo WITHOUT pushing: fetch from the
// clone into the source. The real repo is only ever a fetch destination, never a push target.
export function fetchBranchBack(repoPath, clonePath, branch) {
  execFileSync('git', ['fetch', '--quiet', path.resolve(clonePath), `${branch}:${branch}`], { cwd: path.resolve(repoPath) });
}
