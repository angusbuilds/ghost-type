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

export function ensureState() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
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
