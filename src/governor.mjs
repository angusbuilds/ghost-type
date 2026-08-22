// src/governor.mjs

// Total tokens for a usage object. Anthropic bills ALL FOUR buckets — input, output, and both cache
// tiers (creation + read) — as usage; summing only input+output undercounted a cached call by up to
// ~300x (e.g. 937 vs 285759), leaving the nightly token cap effectively unenforced (round 28 #7).
export function usageTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.output_tokens || 0)
       + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
}

export class Governor {
  constructor({ maxTokensNight, nightDeadlineMs, maxConsecErrors, maxCostUsd = Infinity }) {
    this.maxTokensNight = maxTokensNight;
    this.nightDeadlineMs = nightDeadlineMs;
    this.maxConsecErrors = maxConsecErrors;
    this.maxCostUsd = maxCostUsd;
    this.tokens = 0;
    this.costUsd = 0;
    this.consecErrors = 0;
  }
  addUsage(usage) { this.tokens += usageTokens(usage); }
  addCost(usd) { if (usd) this.costUsd += usd; }
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
