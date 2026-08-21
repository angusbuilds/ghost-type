// src/haunt.mjs
// Haunt state: which terminal panes the owner has handed to Ghost Type. Selecting a pane
// (from the menu bar) tints it purple; deselecting clears it. The tint/reset commands are
// injected so this is testable offline; state persists under ~/.ghosttype/haunted.json.
import path from 'node:path';
import { STATE_DIR, readJson, writeJson } from './lib.mjs';
import { tmuxTintPane, tmuxResetPane, GHOST_PURPLE_256 } from './tint.mjs';

export const HAUNTED_FILE = path.join(STATE_DIR, 'haunted.json');

export function readHaunted(file = HAUNTED_FILE) { const v = readJson(file, []); return Array.isArray(v) ? v : []; }
export function writeHaunted(list, file = HAUNTED_FILE) { writeJson(file, list); }
export function isHaunted(paneId, file = HAUNTED_FILE) { return readHaunted(file).includes(paneId); }

export function haunt(paneId, { tint = tmuxTintPane, file = HAUNTED_FILE } = {}) {
  const list = readHaunted(file);
  if (!list.includes(paneId)) { list.push(paneId); writeHaunted(list, file); }
  try { tint(paneId, GHOST_PURPLE_256); } catch { /* pane may be gone */ }
  return list;
}

export function unhaunt(paneId, { reset = tmuxResetPane, file = HAUNTED_FILE } = {}) {
  const list = readHaunted(file).filter(p => p !== paneId);
  writeHaunted(list, file);
  try { reset(paneId); } catch { /* pane may be gone */ }
  return list;
}

export function toggleHaunt(paneId, opts = {}) {
  return isHaunted(paneId, opts.file) ? unhaunt(paneId, opts) : haunt(paneId, opts);
}
