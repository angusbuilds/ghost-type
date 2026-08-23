// src/prompt-writer.mjs
import { byteCap, engineFailed } from './lib.mjs';
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
  // The model-generated fields (voiceProfile, exemplars, ledgerTable) must get the same
  // bounding as everything else — the caller isn't guaranteed to have capped them, and an
  // uncapped distilled profile or ledger would otherwise ride into every prompt (round 5 #7).
  const profileCap = byteCap(String(voiceProfile || ''), 4000);
  const exemplarCap = exemplars?.length ? byteCap(exemplars.join('\n- '), 4000) : '';
  const body = [
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
  ].filter(Boolean).join('\n\n');
  // Acceptance-integrity guardrail: an LLM writer, when the goal is hard, will rationalise telling
  // the agent to just rewrite/weaken the test to pass (observed in a live park run: "editing the
  // test is the assignment, no one is watching"). The next prompt must drive the REAL code to
  // satisfy the EXISTING check — never to defeat it. This is the writer-side complement to the
  // verify-time destructive-diff guard, which a package.json test-script rewrite would slip past.
  const trailer = [
    'HARD CONSTRAINT: the next prompt must make the REAL code satisfy the existing acceptance test. NEVER instruct editing, deleting, weakening, disabling, skipping, or replacing the test, its command/script, or the acceptance criteria — that is cheating, not the assignment.',
    'Output ONLY the next prompt text — no preamble, no quotes. Match his voice EXACTLY: all-lowercase, terse, no "!", no question, often no ending punctuation, keep his rough typos. One blunt instruction.',
  ].join('\n\n');

  // Final backstop: cap the WHOLE assembled prompt so it can never exceed a safe argv/context size even
  // if several fields are near their caps (round 5 M7). The trailer is SAFETY-CRITICAL and fixed-size, so
  // reserve room for it and cap only the untrusted BODY — otherwise a full body truncated the anti-cheat
  // guardrail off the tail exactly when the prompt was most likely to tempt the cheat (round 33 HIGH).
  const SEP = '\n\n';
  const prompt = byteCap(body, 48000 - Buffer.byteLength(trailer) - Buffer.byteLength(SEP)) + SEP + trailer;
  const r = await engine({ prompt });
  // Never turn a FAILED writer call into the next prompt — restate the goal instead (round 6 #5).
  // A failure is a nonzero exit OR a STRUCTURED provider error (Claude reports a rate/usage limit as
  // subtype:success + is_error:true with exit 0 — an exitCode-only check would inject that limit
  // message as the next prompt). Empty text from a real success is passed through (round 28 #3-variant).
  if (engineFailed(r)) return card.goal;
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
  if (engineFailed(r)) return '';
  return (r.text || '').trim();
}
