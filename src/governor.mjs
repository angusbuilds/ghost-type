// src/governor.mjs
export class Governor {
  constructor({ maxTokensNight, nightDeadlineMs, maxConsecErrors }) {
    this.maxTokensNight = maxTokensNight;
    this.nightDeadlineMs = nightDeadlineMs;
    this.maxConsecErrors = maxConsecErrors;
    this.tokens = 0;
    this.consecErrors = 0;
  }
  addUsage(usage) {
    if (!usage) return;
    this.tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
  }
  noteError() { this.consecErrors += 1; }
  noteOk() { this.consecErrors = 0; }
  check(nowMs) {
    if (this.tokens >= this.maxTokensNight) return { ok: false, trip: 'token-budget' };
    if (nowMs >= this.nightDeadlineMs) return { ok: false, trip: 'night-deadline' };
    if (this.consecErrors >= this.maxConsecErrors) return { ok: false, trip: 'consecutive-errors' };
    return { ok: true, trip: null };
  }
}
