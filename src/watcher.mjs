// src/watcher.mjs
import { parseResetTime } from './reset-time.mjs';

const RATE = /(usage|rate)\s*limit|resets?\s+in|try again in|quota (?:exceeded|reached)/i;
const NET = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network (?:error|unreachable)|getaddrinfo/i;

// Order matters: rate-limit and network are more specific than the generic
// success/stall split, and idle is never conflated with done or rate-limited.
export function classifyOutcome({ exitCode, result, text, nowMs }) {
  const resultMsg = result?.result || '';

  // 1. Structured success wins outright — a successful reply that merely MENTIONS a rate
  //    limit ("fixed the rate limit") must not be misread as rate-limited (Codex H4).
  if (result?.subtype === 'success' && exitCode === 0) return { state: 'done' };

  // 2. Rate-limit only on a non-success. Parse the reset from whichever field matched (M4).
  const rateInResult = RATE.test(resultMsg);
  const rateInText = RATE.test(text || '');
  if (rateInResult || rateInText) {
    const src = rateInResult ? resultMsg : text;
    return { state: 'rate-limited', resetAtMs: parseResetTime(src, nowMs) ?? (nowMs + 60 * 60 * 1000) };
  }

  // 3. Network vs a local transport/process failure — a nonzero exit with no result is not
  //    necessarily a network problem (missing binary, signal, disk) (M4).
  const combined = `${text || ''} ${resultMsg}`;
  if (NET.test(combined)) return { state: 'network' };
  if (exitCode !== 0 && !result) return { state: 'errored' };

  return { state: 'stalled' };
}
