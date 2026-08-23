// src/reset-time.mjs
// Rate-limit exhaustion surfaces as free text in the result message, not a field,
// so we parse the common relative forms Claude Code emits. Absolute-clock forms
// (e.g. "resets 3pm") are deferred to the daemon's fuller parser; M0 handles relative.

// Only parse a duration when a reset/limit trigger phrase is present, then sum every
// duration token near it: handles "resets in 2h 30m", "try again in 45 minutes",
// "in 90 seconds", combined and abbreviated forms alike.
const TRIGGER = /reset|try again|available again|limit reached|rate limit|quota/;
const DURATION = /(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/g;
// Absolute clock form Claude/Codex also emit: "try again at 6:00 PM", "resets at 3pm", "at 11:30 am".
const CLOCK = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/;

export function parseResetTime(text, nowMs) {
  const full = String(text).toLowerCase();
  const trig = full.search(TRIGGER);
  if (trig < 0) return null;
  // Parse ONLY the window at/after the trigger — the reset time follows the phrase ("limit reached,
  // try again in 30m" / "resets at 6 PM"). Scanning the whole text summed unrelated durations
  // ("spent 45m debugging … in 30m" → 75m) and grabbed the wrong clock ("at 9:15 … resets at 6 PM"
  // → 9:15) since assistantText concatenates a whole session's prose (round 32 audit).
  const s = full.slice(trig, trig + 80);

  // 1. Relative durations: "resets in 2h 30m", "try again in 45 minutes".
  let totalMs = 0;
  let found = false;
  for (const m of s.matchAll(DURATION)) {
    const n = Number(m[1]);
    const unit = m[2];
    const mult = unit[0] === 'h' ? 3_600_000 : unit[0] === 'm' ? 60_000 : 1000;
    totalMs += n * mult;
    found = true;
  }
  if (found && totalMs > 0) return nowMs + totalMs;

  // 2. Absolute clock time → the NEXT local occurrence of that time after now, so we wait until the
  //    real reset rather than inventing an hour (round 28 #5). 12h forms use am/pm; a bare hour is 24h.
  const c = s.match(CLOCK);
  if (c) {
    let hour = Number(c[1]);
    const min = c[2] ? Number(c[2]) : 0;
    if (hour <= 23 && min <= 59) {
      if (c[3]) { const pm = c[3][0] === 'p'; hour = (hour % 12) + (pm ? 12 : 0); }
      const d = new Date(nowMs);
      d.setHours(hour, min, 0, 0);
      if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);   // past today → next day, DST-safe (not +24h, which
      return d.getTime();                                     // shifts the clock time across a DST transition)
    }
  }
  return null;
}
