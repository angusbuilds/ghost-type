// src/config.mjs
// One place for the knobs a real deployment needs to tune, read from
// ~/.ghosttype/config.json and merged over safe defaults. Nothing here is required —
// an absent or partial file just falls back to the defaults.
import path from 'node:path';
import { GHOST_HOME, readJson } from './lib.mjs';

export const CONFIG_FILE = path.join(GHOST_HOME, 'config.json');

export const DEFAULTS = {
  maxTokensNight: 2_000_000,   // hard nightly token ceiling
  maxCostUsd: 10,              // hard nightly dollar ceiling
  nightDeadlineHour: 7,        // local hour the night hard-stops
  maxConsecErrors: 3,          // consecutive engine errors before the breaker trips
  humanIdleThreshold: 60,      // seconds of no input before haunt-drive may type
  maxCards: 2,                 // cards per arm when no single project is named
  backpressureThreshold: 3,    // unmerged ghost branches before a project is paused
  pollMs: 5000,                // haunt-drive poll interval
  minStable: 2,                // consecutive stable polls before a pane counts as idle
  defaultEngine: 'claude',
};

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => num(v) && Number.isInteger(v);
// Per-field validators — a positive-finite check alone let `nightDeadlineHour: 999` (≈41
// days out), fractional counts, `minStable: 1`, and a bogus engine name through, each of
// which quietly defeats a safety limit (round 4 #8). A rejected value keeps the default.
const VALIDATORS = {
  maxTokensNight: v => num(v) && v > 0,
  maxCostUsd: v => num(v) && v > 0,
  nightDeadlineHour: v => int(v) && v >= 0 && v <= 23,   // 0 (midnight) is valid; 999 is not
  maxConsecErrors: v => int(v) && v >= 1,
  humanIdleThreshold: v => num(v) && v >= 0,
  maxCards: v => int(v) && v >= 1,
  backpressureThreshold: v => int(v) && v >= 1,
  pollMs: v => int(v) && v >= 250 && v <= 600_000,
  minStable: v => int(v) && v >= 2,                      // a single stable pair is too weak a signal
  defaultEngine: v => v === 'claude' || v === 'codex',
};

// Merge stored config over defaults, keeping only known keys and dropping values that fail
// their field validator so a hand-edited file can't inject nonsense (or unsafe limits).
export function loadConfig(file = CONFIG_FILE) {
  const stored = readJson(file, {});
  const cfg = { ...DEFAULTS };
  if (stored && typeof stored === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in stored)) continue;
      const ok = VALIDATORS[k] ? VALIDATORS[k](stored[k]) : typeof stored[k] === typeof DEFAULTS[k];
      if (ok) cfg[k] = stored[k];
    }
  }
  return cfg;
}

// The next occurrence of the configured hard-stop hour, as an epoch ms.
export function nightDeadlineMs(cfg, now = Date.now()) {
  const d = new Date(now);
  d.setHours(cfg.nightDeadlineHour, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
