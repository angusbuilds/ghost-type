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

const NUMERIC = ['maxTokensNight', 'maxCostUsd', 'nightDeadlineHour', 'maxConsecErrors', 'humanIdleThreshold', 'maxCards', 'backpressureThreshold', 'pollMs', 'minStable'];

// Merge stored config over defaults, keeping only known keys and dropping bad-typed values
// so a hand-edited file can't inject nonsense into the run.
export function loadConfig(file = CONFIG_FILE) {
  const stored = readJson(file, {});
  const cfg = { ...DEFAULTS };
  if (stored && typeof stored === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (!(k in stored)) continue;
      const v = stored[k];
      if (NUMERIC.includes(k)) { if (typeof v === 'number' && Number.isFinite(v) && v > 0) cfg[k] = v; }
      else if (typeof v === typeof DEFAULTS[k]) cfg[k] = v;
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
