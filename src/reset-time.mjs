// src/reset-time.mjs
// Rate-limit exhaustion surfaces as free text in the result message, not a field,
// so we parse the common relative forms Claude Code emits. Absolute-clock forms
// (e.g. "resets 3pm") are deferred to the daemon's fuller parser; M0 handles relative.

// Only parse a duration when a reset/limit trigger phrase is present, then sum every
// duration token near it: handles "resets in 2h 30m", "try again in 45 minutes",
// "in 90 seconds", combined and abbreviated forms alike.
const TRIGGER = /reset|try again|available again|limit reached|rate limit|quota/;
const DURATION = /(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/g;

export function parseResetTime(text, nowMs) {
  const s = String(text).toLowerCase();
  if (!TRIGGER.test(s)) return null;

  let totalMs = 0;
  let found = false;
  for (const m of s.matchAll(DURATION)) {
    const n = Number(m[1]);
    const unit = m[2];
    const mult = unit[0] === 'h' ? 3_600_000 : unit[0] === 'm' ? 60_000 : 1000;
    totalMs += n * mult;
    found = true;
  }
  return found && totalMs > 0 ? nowMs + totalMs : null;
}
