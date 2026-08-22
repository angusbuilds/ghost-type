// src/governor.mjs

// Total tokens for a usage object. Anthropic bills ALL FOUR buckets — input, output, and both cache
// tiers (creation + read) — as usage; summing only input+output undercounted a cached call by up to
// ~300x (e.g. 937 vs 285759), leaving the nightly token cap effectively unenforced (round 28 #7).
// Coerce ONE usage bucket to a non-negative finite number. `|| 0` was not numeric coercion — a
// string field concatenated ("5"+3 → "53") poisoning the total, and a NaN/negative field could zero
// or shrink the count, defeating the cap (round 31 audit #2). Anything not a positive number → 0.
function bucket(x) { const n = Number(x); return Number.isFinite(n) && n > 0 ? n : 0; }

export function usageTokens(usage) {
  if (!usage) return 0;
  return bucket(usage.input_tokens) + bucket(usage.output_tokens)
       + bucket(usage.cache_creation_input_tokens) + bucket(usage.cache_read_input_tokens);
}

const posFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

export class Governor {
  constructor({ maxTokensNight, nightDeadlineMs, maxConsecErrors, maxCostUsd = Infinity }) {
    // Fail CLOSED (loud) on an invalid required cap — a kill-switch that silently failed open would
    // remove the very ceiling that prevents an unbounded overnight bill (round 31 audit #1). Config
    // already validates these, so this only fires if a future caller/refactor passes junk.
    if (!posFinite(maxTokensNight)) throw new Error(`Governor: maxTokensNight must be a positive finite number, got ${maxTokensNight}`);
    if (!posFinite(maxConsecErrors)) throw new Error(`Governor: maxConsecErrors must be a positive finite number, got ${maxConsecErrors}`);
    if (maxCostUsd !== Infinity && !posFinite(maxCostUsd)) throw new Error(`Governor: maxCostUsd must be a positive finite number or Infinity, got ${maxCostUsd}`);
    if (nightDeadlineMs != null && !Number.isFinite(nightDeadlineMs)) throw new Error(`Governor: nightDeadlineMs must be a finite number or null, got ${nightDeadlineMs}`);
    this.maxTokensNight = maxTokensNight;
    this.nightDeadlineMs = nightDeadlineMs;
    this.maxConsecErrors = maxConsecErrors;
    this.maxCostUsd = maxCostUsd;
    this.tokens = 0;
    this.costUsd = 0;
    this.consecErrors = 0;
  }
  addUsage(usage) { this.tokens += usageTokens(usage); }
  // Only a valid positive number moves the accumulator — a negative could decrement the cap and a
  // string could concatenate it into a non-numeric value that never compares >= the ceiling (#3).
  addCost(usd) { if (posFinite(usd)) this.costUsd += usd; }
  noteError() { this.consecErrors += 1; }
  noteOk() { this.consecErrors = 0; }
  // Remaining headroom, so a single in-flight call can be capped to what's actually left and
  // can't overshoot the nightly dollar cap or run past the deadline (round 6 #8).
  remainingUsd() { return this.maxCostUsd === Infinity ? Infinity : Math.max(0, this.maxCostUsd - this.costUsd); }
  remainingMs(nowMs) { return this.nightDeadlineMs == null ? Infinity : Math.max(0, this.nightDeadlineMs - nowMs); }
  check(nowMs) {
    if (this.tokens >= this.maxTokensNight) return { ok: false, trip: 'token-budget' };
    if (this.costUsd >= this.maxCostUsd) return { ok: false, trip: 'cost-budget' };
    // Guard null: a null deadline means "no deadline" (as remainingMs already treats it) — without the
    // guard, `nowMs >= null` coerces to `nowMs >= 0` and trips night-deadline immediately (round 29).
    if (this.nightDeadlineMs != null && nowMs >= this.nightDeadlineMs) return { ok: false, trip: 'night-deadline' };
    if (this.consecErrors >= this.maxConsecErrors) return { ok: false, trip: 'consecutive-errors' };
    return { ok: true, trip: null };
  }
}
