// src/prompt-writer.mjs
import { byteCap } from './lib.mjs';
import { fence, scrubSecrets, shieldScan } from './sanitize.mjs';

const CAP = 12000;

// A writer engine call FAILED if it exited nonzero OR returned a structured provider error
// (subtype:success + is_error:true — Claude's rate/usage-limit shape). Its text must never become a
// prompt or diagnosis; the caller restates the goal / drops the diagnosis instead (round 28 #3-variant).
function writerFailed(r) {
  return Boolean(r && ((r.exitCode != null && r.exitCode !== 0) || r.result?.is_error === true));
}

// Compose the next prompt in Angus's voice. All repo-derived inputs are treated as
// untrusted data: scrubbed, byte-capped, fenced, and shield-scanned. A shield hit is
// GATING — we throw so the caller parks the card rather than feeding a payload forward.
export async function writeNextPrompt({ card, diffTail, testTail, notesTail, transcriptTail, voiceProfile, exemplars, failure, ledgerTable, rawTrace, engine }) {
  const untrusted = [diffTail, testTail, notesTail, transcriptTail, rawTrace].join('\n');
  const scan = shieldScan(untrusted);
  if (scan.hit) { const e = new Error('SHIELD_HIT'); e.patterns = scan.patterns; throw e; }

  const clean = (t) => byteCap(scrubSecrets(String(t || '')), CAP);
  // The model-generated fields (voiceProfile, exemplars, ledgerTable) must get the same
  // bounding as everything else — the caller isn't guaranteed to have capped them, and an
  // uncapped distilled profile or ledger would otherwise ride into every prompt (round 5 #7).
  const profileCap = byteCap(String(voiceProfile || ''), 4000);
  const exemplarCap = exemplars?.length ? byteCap(exemplars.join('\n- '), 4000) : '';
  const meta = [
    'You are writing the NEXT prompt to send to a coding agent, phrased exactly as this developer would type it.',
    `VOICE PROFILE (imitate this style):\n${profileCap}`,
    exemplarCap ? `EXAMPLES OF HOW HE WRITES:\n- ${exemplarCap}` : '',
    `THE GOAL: ${card.goal}`,
    failure ? `WHAT JUST FAILED: exit ${failure.code}\n${clean(failure.stderrHead)}` : '',
    ledgerTable ? `WHAT YOU'VE ALREADY TRIED (do not repeat a dead end):\n${byteCap(String(ledgerTable), CAP)}` : '',
    rawTrace ? fence('raw-trace', clean(rawTrace)) : '',
    fence('diff', clean(diffTail)),
    fence('test-output', clean(testTail)),
    fence('night-notes', clean(notesTail)),
    fence('transcript', clean(transcriptTail)),
    'Output ONLY the next prompt text — no preamble, no quotes. Match his voice EXACTLY: all-lowercase, terse, no "!", no question, often no ending punctuation, keep his rough typos. One blunt instruction.',
  ].filter(Boolean).join('\n\n');

  // Final backstop: cap the WHOLE assembled prompt so it can never exceed a safe argv/context
  // size even if several fields are near their individual caps (round 5 M7).
  const r = await engine({ prompt: byteCap(meta, 48000) });
  // Never turn a FAILED writer call into the next prompt — restate the goal instead (round 6 #5).
  // A failure is a nonzero exit OR a STRUCTURED provider error (Claude reports a rate/usage limit as
  // subtype:success + is_error:true with exit 0 — an exitCode-only check would inject that limit
  // message as the next prompt). Empty text from a real success is passed through (round 28 #3-variant).
  if (writerFailed(r)) return card.goal;
  return (r.text || '').trim();
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
  // A failed writer call must not become the diagnosis text (round 6 #5) — diagnosis is optional,
  // so drop it (incl. a structured is_error limit, round 28 #3-variant) and proceed without one.
  if (writerFailed(r)) return '';
  return (r.text || '').trim();
}
