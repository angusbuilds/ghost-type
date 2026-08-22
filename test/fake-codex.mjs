#!/usr/bin/env node
// test/fake-codex.mjs — stand-in for `codex exec --json`. Emits JSONL events chosen by
// GHOST_FAKE_SCENARIO so the Codex adapter is testable offline.
const scenario = process.env.GHOST_FAKE_SCENARIO || 'success';
const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// Emits the CURRENT codex 0.148 schema (verified against the live CLI, round 8): assistant text
// nested in item.completed, usage in turn.completed — not the old top-level agent_message/token_count.
line({ type: 'thread.started', thread_id: 't0' });
line({ type: 'turn.started' });
if (scenario === 'success') {
  line({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'created the FIXED file and it passes' } });
  line({ type: 'turn.completed', usage: { input_tokens: 90, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0 } });
  process.exit(0);
} else if (scenario === 'stall') {
  line({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'could not resolve the failure' } });
  line({ type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 10 } });   // a completed turn that didn't fix it
  process.exit(0);
} else if (scenario === 'no-events') {
  process.exit(0);   // exit 0 but emits nothing — a truncated/invalid turn, must NOT be success (round 12)
} else if (scenario === 'crash') {
  process.stderr.write('codex: fatal error\n');
  process.exit(1);
} else if (scenario === 'usage-limit') {
  // a STRUCTURED provider failure — a usage limit — as turn.failed + nonzero exit (round 28 #4).
  // Emit SOME assistant text first, then fail: the error message must still win for classification,
  // not the assistant text (round 29 — a turn that partially replied then hit the limit).
  line({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'starting on the task...' } });
  line({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 30 minutes." } });
  process.exit(1);
}
