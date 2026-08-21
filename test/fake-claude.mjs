#!/usr/bin/env node
// test/fake-claude.mjs — a stand-in for the `claude` binary. Emits scripted
// stream-json chosen by GHOST_FAKE_SCENARIO so the whole loop is testable offline.
// It ignores all CLI flags except reading the prompt from argv/stdin.
const scenario = process.env.GHOST_FAKE_SCENARIO || 'success';
function line(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

line({ type: 'system', subtype: 'init' });

if (scenario === 'success') {
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'implemented the fix' }] } });
  line({ type: 'result', subtype: 'success', result: 'implemented the fix', usage: { input_tokens: 100, output_tokens: 50 }, total_cost_usd: 0.02 });
  process.exit(0);
} else if (scenario === 'rate-limit') {
  line({ type: 'result', subtype: 'error', result: 'usage limit reached, resets in 1h 15m', usage: { input_tokens: 5, output_tokens: 0 }, total_cost_usd: 0 });
  process.exit(0);
} else if (scenario === 'stall') {
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'I tried but the test still fails' }] } });
  line({ type: 'result', subtype: 'error', result: 'could not resolve the failure', usage: { input_tokens: 80, output_tokens: 20 }, total_cost_usd: 0.01 });
  process.exit(0);
} else if (scenario === 'network') {
  process.stderr.write('fetch failed: ENOTFOUND api.anthropic.com\n');
  process.exit(1);
} else if (scenario === 'crash-after-result') {
  // A structured result IS emitted, but the process then exits nonzero — the exact case
  // where a retained result would be mis-classified as a soft 'stalled' (round 4 #4).
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial work' }] } });
  line({ type: 'result', subtype: 'success', result: 'looked done', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 });
  process.exit(1);
}
