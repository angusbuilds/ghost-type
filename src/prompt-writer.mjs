// src/prompt-writer.mjs
import { byteCap } from './lib.mjs';
import { fence, scrubSecrets, shieldScan } from './sanitize.mjs';

const CAP = 12000;

// Compose the next prompt in Angus's voice. All repo-derived inputs are treated as
// untrusted data: scrubbed, byte-capped, fenced, and shield-scanned. A shield hit is
// GATING — we throw so the caller parks the card rather than feeding a payload forward.
export async function writeNextPrompt({ card, diffTail, testTail, notesTail, transcriptTail, voiceProfile, exemplars, failure, ledgerTable, rawTrace, engine }) {
  const untrusted = [diffTail, testTail, notesTail, transcriptTail, rawTrace].join('\n');
  const scan = shieldScan(untrusted);
  if (scan.hit) { const e = new Error('SHIELD_HIT'); e.patterns = scan.patterns; throw e; }

  const clean = (t) => byteCap(scrubSecrets(String(t || '')), CAP);
  const meta = [
    'You are writing the NEXT prompt to send to a coding agent, phrased exactly as this developer would type it.',
    `VOICE PROFILE (imitate this style):\n${voiceProfile}`,
    exemplars?.length ? `EXAMPLES OF HOW HE WRITES:\n- ${exemplars.join('\n- ')}` : '',
    `THE GOAL: ${card.goal}`,
    failure ? `WHAT JUST FAILED: exit ${failure.code}\n${clean(failure.stderrHead)}` : '',
    ledgerTable ? `WHAT YOU'VE ALREADY TRIED (do not repeat a dead end):\n${ledgerTable}` : '',
    rawTrace ? fence('raw-trace', clean(rawTrace)) : '',
    fence('diff', clean(diffTail)),
    fence('test-output', clean(testTail)),
    fence('night-notes', clean(notesTail)),
    fence('transcript', clean(transcriptTail)),
    'Output ONLY the next prompt text — no preamble, no quotes. Keep it in his voice: direct, concrete, one clear instruction.',
  ].filter(Boolean).join('\n\n');

  const r = await engine({ prompt: meta });
  return r.text.trim();
}

// Force a written diagnosis from the RAW trace before any next-prompt is drafted.
// Reflexion's ablation: a diagnosis beats a scalar/summary for the next attempt.
export async function diagnoseFailure({ goal, rawTrace, engine }) {
  const clean = byteCap(scrubSecrets(String(rawTrace || '')), CAP);
  const r = await engine({
    prompt: [
      `A coding attempt failed. GOAL: ${goal}`,
      fence('raw-trace', clean),
      'In 1-3 sentences, diagnose exactly WHY it failed. Be specific and technical. Output only the diagnosis.',
    ].join('\n\n'),
  });
  return (r.text || '').trim();
}
