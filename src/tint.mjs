// src/tint.mjs
// Make a terminal glow purple while the ghost is driving it, and clear it the instant
// it lets go. Phase-2 (haunt mode) spike — but the mechanism is stable enough to land now.
//
// Two layers, picked by environment:
//   * OSC 11 / 111 — set/reset the terminal's default background color. Portable across
//     ghostty, kitty, WezTerm, iTerm2, xterm. This is the primary path.
//   * tmux select-pane -P bg=... — per-PANE background when running inside tmux, so only
//     the haunted pane glows, not the whole window.
import { execFileSync } from 'node:child_process';

// Ghost Type's signature purple.
export const GHOST_PURPLE = '#5a2ca0';
// Nearest tmux 256-color slot (a deep violet) for per-pane tinting.
export const GHOST_PURPLE_256 = 'colour55';

// OSC 11: set default background. Terminated with BEL (\x07) — widely accepted.
export function tintSequence(hex = GHOST_PURPLE) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`tint: bad hex ${hex}`);
  return `\x1b]11;${hex}\x07`;
}

// OSC 111: reset default background to the terminal's configured default.
export function resetSequence() {
  return '\x1b]111\x07';
}

// True when we're running inside tmux (per-pane tinting is available and preferable).
export function inTmux(env = process.env) {
  return Boolean(env.TMUX);
}

// Tint a specific tmux pane (e.g. "%3" or "session:win.pane"). Only that pane glows.
// stdio suppressed so a failed call (closed pane / dead tmux server — routine when the driven
// terminal is closed while haunted) doesn't leak tmux's "no server running" to the CLI's stderr,
// which the callers silently catch and the Swift app reads as a false failure signal (round 32 audit).
export function tmuxTintPane(target, color = GHOST_PURPLE_256) {
  execFileSync('tmux', ['select-pane', '-t', target, '-P', `bg=${color}`], { stdio: ['ignore', 'ignore', 'ignore'] });
}

export function tmuxResetPane(target) {
  execFileSync('tmux', ['select-pane', '-t', target, '-P', 'default'], { stdio: ['ignore', 'ignore', 'ignore'] });
}

// Convenience for the current (non-tmux) terminal: write straight to a stream.
export function tintStream(stream = process.stdout, hex = GHOST_PURPLE) {
  stream.write(tintSequence(hex));
}

export function resetStream(stream = process.stdout) {
  stream.write(resetSequence());
}
