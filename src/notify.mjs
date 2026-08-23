// src/notify.mjs
// A morning push so a good (or bad) night never sits unseen. macOS notification via
// osascript; the command runner is injectable for tests.
import { execFileSync } from 'node:child_process';

export function verdictLine(night) {
  const shipped = night.cards.filter(c => c.mergeReady).length;
  const proposed = night.cards.filter(c => c.outcome === 'proposed').length;
  const parked = night.cards.filter(c => c.outcome === 'parked').length;
  const review = shipped === 1 ? '1 branch' : `${shipped} branches`;
  // Surface proposals so a proposal-only night doesn't push "0 shipped · 0 parked" (reads as
  // "nothing ran") — same accuracy gap the HTML/markdown reports had (round 34). Shown only when
  // present to keep the push terse; "review" still counts merge-ready branches, not plans.
  return `${shipped} shipped${proposed ? ` · ${proposed} proposed` : ''} · ${parked} parked · review ${review}`;
}

function osascriptRunner(title, message) {
  execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
}

// Never throws — a failed notification must not crash the night.
export function notify(title, message, { runner = osascriptRunner } = {}) {
  try { runner(title, message); return true; } catch { return false; }
}

export function notifyVerdict(night, opts = {}) {
  return notify('👻 Ghost Type', verdictLine(night), opts);
}
