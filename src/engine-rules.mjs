// src/engine-rules.mjs
// Engine-specific prompt shaping (from the prompting study). The REGISTER never changes —
// his lowercase, terse, directive voice applies to both engines. What changes is structure:
// Claude Code handles a loose high-level directive; Codex is literal and step-driven, so it
// gets an explicit ordered tail (files in scope → command to run → concrete stop condition).
export function shapeForEngine(prompt, engine = 'claude', card = {}) {
  // A blank next-prompt (prompt-writer returns '' on a successful-but-empty writer call, round 28
  // #3-variant) would otherwise be dressed up as a fully-formed but GOAL-LESS instruction — for codex an
  // ordered "make the changes / run the test / stop at exit 0" with nothing to actually do, burning an
  // iteration + budget on a directionless run. Fall back to the card's goal, matching writeNextPrompt's
  // own engineFailed→goal path; a real prompt is passed through unchanged (round 35).
  const base = String(prompt ?? '').trim() === '' ? String(card.goal ?? '') : prompt;
  if (engine !== 'codex') return base;
  const testCmd = (card.acceptanceArgv || []).join(' ') || 'the test command';
  return [
    base,
    '',
    'do it step by step:',
    '1. make the changes in this repo',
    `2. run: ${testCmd}`,
    '3. if it fails, read the error, fix it, and re-run',
    'stop when that command exits 0. dont touch anything outside this repo.',
  ].join('\n');
}
