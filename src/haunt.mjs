// src/haunt.mjs
// Haunt state: which terminal panes the owner has handed to Ghost Type. Selecting a pane
// (from the menu bar) tints it purple; deselecting clears it. The tint/reset commands are
// injected so this is testable offline; state persists under ~/.ghosttype/haunted.json.
import path from 'node:path';
import { STATE_DIR, readJson, writeJson, withFileLock } from './lib.mjs';
import { tmuxTintPane, tmuxResetPane, GHOST_PURPLE_256 } from './tint.mjs';

export const HAUNTED_FILE = path.join(STATE_DIR, 'haunted.json');

export function readHaunted(file = HAUNTED_FILE) { const v = readJson(file, []); return Array.isArray(v) ? v : []; }
export function writeHaunted(list, file = HAUNTED_FILE) { writeJson(file, list); }
export function isHaunted(paneId, file = HAUNTED_FILE) { return readHaunted(file).includes(paneId); }

// The read-modify-write is serialized cross-process (round 35): two `ghost haunt` invocations racing
// each read-then-write the whole list, so the second clobbered the first — dropping a tinted pane from
// tracked state. The tint/reset shell-out stays OUTSIDE the lock (idempotent, and must not hold the lock
// during a tmux call).
export function haunt(paneId, { tint = tmuxTintPane, file = HAUNTED_FILE } = {}) {
  const list = withFileLock(file, () => {
    const cur = readHaunted(file);
    if (!cur.includes(paneId)) { cur.push(paneId); writeHaunted(cur, file); }
    return cur;
  });
  try { tint(paneId, GHOST_PURPLE_256); } catch { /* pane may be gone */ }
  return list;
}

export function unhaunt(paneId, { reset = tmuxResetPane, file = HAUNTED_FILE } = {}) {
  const list = withFileLock(file, () => {
    const cur = readHaunted(file).filter(p => p !== paneId);
    writeHaunted(cur, file);
    return cur;
  });
  try { reset(paneId); } catch { /* pane may be gone */ }
  return list;
}

export function toggleHaunt(paneId, opts = {}) {
  return isHaunted(paneId, opts.file) ? unhaunt(paneId, opts) : haunt(paneId, opts);
}
