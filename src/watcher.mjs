// src/watcher.mjs
import { parseResetTime } from './reset-time.mjs';

// A bare "resets in" / "try again in" is NOT a rate limit — a test log or commit message can
// say that (round 5 review #4). Require a limit/quota/usage keyword, either standalone
// ("usage limit") or within ~40 chars of the reset phrase.
const RATE = /(?:usage|rate)\s*limit|quota (?:exceeded|reached)|(?:limit|quota|usage)[^.\n]{0,40}(?:resets?\s+in|try again in)|(?:resets?\s+in|try again in)[^.\n]{0,40}(?:limit|quota|usage)/i;
const NET = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network (?:error|unreachable)|getaddrinfo/i;

// Order matters: rate-limit and network are more specific than the generic
// success/stall split, and idle is never conflated with done or rate-limited.
export function classifyOutcome({ exitCode, result, text, nowMs }) {
  const resultMsg = result?.result || '';
  const combined = `${text || ''} ${resultMsg}`;

  // 1. Structured success wins outright — a successful reply that merely MENTIONS a rate
  //    limit ("fixed the rate limit") must not be misread as rate-limited (Codex H4).
  if (result?.subtype === 'success' && exitCode === 0) return { state: 'done' };

  // 2. A nonzero exit with NO structured result is a TRANSPORT failure (crashed process,
  //    missing binary, signal, disk). Classify it before any rate/limit text-matching, so a
  //    crash whose output merely mentions "rate limit" isn't taken for a real one (round 5 L2).
  if (exitCode !== 0 && !result) {
    return NET.test(combined) ? { state: 'network' } : { state: 'errored' };
  }

  // 3. Rate-limit — a real one arrives as a structured provider error (exitCode 0) or canonical
  //    text. Parse the reset from whichever field matched (M4).
  const rateInResult = RATE.test(resultMsg);
  const rateInText = RATE.test(text || '');
  if (rateInResult || rateInText) {
    const src = rateInResult ? resultMsg : text;
    return { state: 'rate-limited', resetAtMs: parseResetTime(src, nowMs) ?? (nowMs + 60 * 60 * 1000) };
  }

  // 4. Network mention on an otherwise-structured result.
  if (NET.test(combined)) return { state: 'network' };

  return { state: 'stalled' };
}
