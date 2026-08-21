// src/watcher.mjs
import { parseResetTime } from './reset-time.mjs';

const RATE = /(usage|rate)\s*limit|resets?\s+in|try again in|quota (?:exceeded|reached)/i;
const NET = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network (?:error|unreachable)|getaddrinfo/i;

// Order matters: rate-limit and network are more specific than the generic
// success/stall split, and idle is never conflated with done or rate-limited.
export function classifyOutcome({ exitCode, result, text, nowMs }) {
  const resultMsg = result?.result || '';
  const msg = `${text || ''} ${resultMsg}`;
  // Parse the reset duration from a SINGLE source — text and result often echo the
  // same string, and summing both would double the wait (e.g. "1h" counted twice).
  const resetSource = resultMsg || text || '';

  if (RATE.test(msg)) {
    return { state: 'rate-limited', resetAtMs: parseResetTime(resetSource, nowMs) ?? (nowMs + 60 * 60 * 1000) };
  }
  if (NET.test(msg) || (exitCode !== 0 && !result)) {
    return { state: 'network' };
  }
  if (result?.subtype === 'success' && exitCode === 0) {
    return { state: 'done' };
  }
  return { state: 'stalled' };
}
