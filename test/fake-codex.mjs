#!/usr/bin/env node
// test/fake-codex.mjs — stand-in for `codex exec --json`. Emits JSONL events chosen by
// GHOST_FAKE_SCENARIO so the Codex adapter is testable offline.
const scenario = process.env.GHOST_FAKE_SCENARIO || 'success';
const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');

line({ type: 'session_configured', model: 'gpt-5-codex' });
if (scenario === 'success') {
  line({ type: 'agent_message', text: 'created the FIXED file and it passes' });
  line({ type: 'token_count', input_tokens: 90, output_tokens: 40 });
  process.exit(0);
} else if (scenario === 'stall') {
  line({ type: 'agent_message', text: 'could not resolve the failure' });
  process.exit(0);
} else if (scenario === 'crash') {
  process.stderr.write('codex: fatal error\n');
  process.exit(1);
}
