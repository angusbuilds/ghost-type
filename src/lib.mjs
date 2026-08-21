// src/lib.mjs
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

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

// Atomic write: temp file + flush + rename, so a crash mid-write can never leave a
// truncated JSON file that the next read treats as empty (Codex M1).
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

export function log(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging must never throw */ }
}

// Truncate to a byte ceiling, appending a visible marker when cut.
export function byteCap(text, maxBytes) {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.byteLength <= maxBytes) return String(text);
  const head = buf.subarray(0, maxBytes).toString('utf8');
  const dropped = buf.byteLength - maxBytes;
  return `${head}\n[truncated ${dropped} bytes]`;
}
