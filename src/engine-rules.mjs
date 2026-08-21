// src/engine-rules.mjs
// Engine-specific prompt shaping (from the prompting study). The REGISTER never changes —
// his lowercase, terse, directive voice applies to both engines. What changes is structure:
// Claude Code handles a loose high-level directive; Codex is literal and step-driven, so it
// gets an explicit ordered tail (files in scope → command to run → concrete stop condition).
export function shapeForEngine(prompt, engine = 'claude', card = {}) {
  if (engine !== 'codex') return prompt;
  const testCmd = (card.acceptanceArgv || []).join(' ') || 'the test command';
  return [
    prompt,
    '',
    'do it step by step:',
    '1. make the changes in this repo',
    `2. run: ${testCmd}`,
    '3. if it fails, read the error, fix it, and re-run',
    'stop when that command exits 0. dont touch anything outside this repo.',
  ].join('\n');
}
