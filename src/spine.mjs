// src/spine.mjs
import { classifyOutcome } from './watcher.mjs';
import { shieldScan } from './sanitize.mjs';
import { Ledger } from './ledger.mjs';
import { log } from './lib.mjs';

// The card driver. Loops: run engine → classify → patch-guard → verify (grounding the
// agent's claim) → pass ships, fail feeds a diagnosis + ledger + pre-flight-voted next
// prompt. Rate-limit sleeps; network backs off. Parks after maxIterations or a shield hit.
// M1 deps are all defaulted so M0 callers are unaffected.
export async function runCard(card, deps) {
  const {
    now, makeClone, commit, gitDiff, runEngine, verify, writeNextPrompt,
    sleepUntil = async () => {}, voiceProfile = 'direct, terse, verification-driven', exemplars = [],
    // M1 capabilities — defaulted to M0-equivalent behavior:
    headRef = () => 'HEAD',
    patchApplied = () => true,
    classifyClaim = () => ({ claimedDone: false, falseDone: false }),
    diagnoseFailure = async () => '',
    generateCandidates = async () => [],
    voteBest = async ({ candidates }) => ({ choice: candidates[0], index: 0 }),
    recordPrompt = () => {},                 // lineage sink (defaulted off for tests)
    governor = null,                         // if present, meters EVERY engine call (Codex H5)
  } = deps;

  const clonePath = makeClone(card.repoPath, card.branch.replace(/[^\w.-]/g, '_'));
  const baseRef = headRef(clonePath);
  const ledger = new Ledger();
  const promptsWritten = [];
  let prompt = card.goal;
  let lastTestOutput = '';
  let iterations = 0;
  let netBackoffs = 0;
  let rateWaits = 0;
  let falseDoneCount = 0;
  let tokensUsed = 0;

  // Every engine call — main, diagnosis, candidates, vote — goes through here so the
  // governor sees all of them and the token counter is honest (Codex H5).
  const meter = (r) => { if (r?.usage) { tokensUsed += (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0); governor?.addUsage(r.usage); } return r; };
  const writerEngine = async ({ prompt }) => meter(await runEngine({ cwd: clonePath, prompt, card, writer: true }));

  // Compose the next prompt: forced diagnosis from the raw trace, the full attempt
  // ledger, then pre-flight candidate generation + a judge vote. Falls back to a single
  // writeNextPrompt when no candidates are produced. Shield-gates untrusted inputs.
  async function composeNext({ engText, testOutput }) {
    // Don't spend on diagnosis/candidates/vote if the governor has already tripped (#2).
    if (governor) { const c = governor.check(now()); if (!c.ok) { const e = new Error('GOVERNOR_TRIP'); e.trip = c.trip; throw e; } }
    const rawTrace = `${testOutput || ''}\n${engText || ''}`;
    const scan = shieldScan(rawTrace);
    if (scan.hit) { const e = new Error('SHIELD_HIT'); e.patterns = scan.patterns; throw e; }

    const diagnosis = await diagnoseFailure({ goal: card.goal, rawTrace, engine: writerEngine });
    // Voice MUST ride the primary (candidate) path, not just the fallback — otherwise the
    // prompts the loop actually uses are voice-blind (bug caught by the prompting study).
    const context = [
      `WRITE EXACTLY IN THIS VOICE:\n${voiceProfile}`,
      exemplars?.length ? `HOW HE WRITES:\n- ${exemplars.join('\n- ')}` : '',
      `GOAL: ${card.goal}`,
      diagnosis ? `DIAGNOSIS OF LAST FAILURE: ${diagnosis}` : '',
      `ALREADY TRIED (do not repeat a dead end):\n${ledger.toTable()}`,
    ].filter(Boolean).join('\n\n');

    const candidates = await generateCandidates({ context, n: 3, engine: writerEngine });
    if (candidates.length > 0) {
      const { choice } = await voteBest({ candidates, context, engine: writerEngine });
      return choice;
    }
    // fallback: the M0 single-shot writer, now fed the ledger + raw trace
    return writeNextPrompt({
      card, diffTail: gitDiff(clonePath).excerpt, testTail: testOutput, notesTail: '',
      transcriptTail: engText, voiceProfile, exemplars, failure: { code: 1, stderrHead: testOutput },
      ledgerTable: ledger.toTable(), rawTrace, engine: writerEngine,
    });
  }

  while (iterations < card.maxIterations) {
    // Stop before spending if the governor has tripped (token/deadline/consecutive-error).
    if (governor) { const c = governor.check(now()); if (!c.ok) return { ...park(card, `governor: ${c.trip}`, iterations, lastTestOutput, promptsWritten, undefined, falseDoneCount, ledger), tokensUsed }; }
    iterations += 1;
    const eng = meter(await runEngine({ cwd: clonePath, prompt, card }));
    const outcome = classifyOutcome({ exitCode: eng.exitCode, result: eng.result, text: eng.text, nowMs: now() });

    if (outcome.state === 'rate-limited') {
      iterations -= 1;                       // not a real attempt — don't spend the budget
      if (++rateWaits > 6) return { ...park(card, 'rate-limited too many times', iterations, lastTestOutput, promptsWritten, undefined, falseDoneCount, ledger), tokensUsed };
      await sleepUntil(outcome.resetAtMs);
      continue;
    }
    if (outcome.state === 'network' || outcome.state === 'errored') {
      iterations -= 1;
      governor?.noteError();
      if (++netBackoffs > 3) return { ...park(card, outcome.state === 'errored' ? 'engine errored repeatedly' : 'network unreachable after retries', iterations, lastTestOutput, promptsWritten, undefined, falseDoneCount, ledger), tokensUsed };
      await sleepUntil(now() + 30_000);
      continue;
    }
    netBackoffs = 0;   // a real attempt happened — reset the transient-failure counter

    // PATCH-APPLIED GUARD — before spending a test cycle, confirm the tree actually changed.
    if (!patchApplied(clonePath, baseRef)) {
      lastTestOutput = 'no patch applied — the working tree did not change';
      const claim = classifyClaim({ claimText: eng.text, verifyPass: false });
      if (claim.falseDone) { falseDoneCount += 1; log({ evt: 'false-done', project: card.project, iteration: iterations, why: 'claimed done, no patch' }); }
      ledger.record({ iteration: iterations, prompt, outcome: 'no-patch', exitCode: null, stderrHead: lastTestOutput, howClose: 'agent produced no changes' });
      if (iterations >= card.maxIterations) return { ...park(card, 'no patch applied — working tree unchanged', iterations, lastTestOutput, promptsWritten, undefined, falseDoneCount, ledger), tokensUsed };
      try { prompt = await composeNext({ engText: eng.text, testOutput: lastTestOutput }); promptsWritten.push(prompt); recordPrompt({ iteration: iterations, prompt, outcome: 'no-patch', project: card.project }); }
      catch (e) { if (e.message === 'SHIELD_HIT') return { ...park(card, 'shield hit — injection signal in session output', iterations, lastTestOutput, promptsWritten, e.patterns, falseDoneCount, ledger), tokensUsed }; if (e.message === 'GOVERNOR_TRIP') return { ...park(card, `governor: ${e.trip}`, iterations, lastTestOutput, promptsWritten, undefined, falseDoneCount, ledger), tokensUsed }; throw e; }
      continue;
    }

    // VERIFY — run the acceptance test ourselves; ground the agent's claim against it.
    const v = await verify(card, clonePath, { gitDiff });
    lastTestOutput = v.detail.testOutput;
    const claim = classifyClaim({ claimText: eng.text, verifyPass: v.pass });
    if (claim.falseDone) { falseDoneCount += 1; log({ evt: 'false-done', project: card.project, iteration: iterations, why: 'claimed done, tests failed' }); }

    if (v.pass) {
      governor?.noteOk();
      commit(clonePath, card.branch);
      recordPrompt({ iteration: iterations, prompt, outcome: 'shipped', project: card.project });
      log({ evt: 'card-shipped', project: card.project, iterations, falseDoneCount, tokensUsed });
      return { project: card.project, goal: card.goal, outcome: 'shipped', mergeReady: true, whyLine: 'acceptance passed', iterations, branch: card.branch, testOutput: lastTestOutput, promptsWritten, falseDoneCount, ledger: ledger.rows, tokensUsed };
    }

    governor?.noteError();
    ledger.record({ iteration: iterations, prompt, outcome: 'fail', exitCode: 1, stderrHead: v.detail.testOutput, howClose: claim.claimedDone ? 'claimed done but tests failed' : 'tests failed' });
    if (iterations >= card.maxIterations) break;
    try { prompt = await composeNext({ engText: eng.text, testOutput: v.detail.testOutput }); promptsWritten.push(prompt); recordPrompt({ iteration: iterations, prompt, outcome: 'fail', project: card.project }); }
    catch (e) { if (e.message === 'SHIELD_HIT') return { ...park(card, 'shield hit — injection signal in session output', iterations, lastTestOutput, promptsWritten, e.patterns, falseDoneCount, ledger), tokensUsed }; if (e.message === 'GOVERNOR_TRIP') return { ...park(card, `governor: ${e.trip}`, iterations, lastTestOutput, promptsWritten, undefined, falseDoneCount, ledger), tokensUsed }; throw e; }
  }
  return { ...park(card, `no pass after ${card.maxIterations} iterations`, iterations, lastTestOutput, promptsWritten, undefined, falseDoneCount, ledger), tokensUsed };
}

function park(card, why, iterations, testOutput, promptsWritten, patterns, falseDoneCount = 0, ledger = { rows: [] }) {
  log({ evt: 'card-parked', project: card.project, why, patterns, falseDoneCount });
  return { project: card.project, goal: card.goal, outcome: 'parked', mergeReady: false, whyLine: why, iterations, branch: card.branch, testOutput, promptsWritten, falseDoneCount, ledger: ledger.rows };
}

export async function runNight(cards, deps) {
  const results = [];
  const gov = deps.governor;
  let tripReason = null;
  for (const card of cards) {
    // Enforce the nightly caps BEFORE spending on the next card, and stop cleanly on a trip.
    if (gov) {
      const c = gov.check(deps.now());
      if (!c.ok) { tripReason = c.trip; break; }
    }
    // runCard meters every engine call into the governor itself (Codex H5) — don't
    // double-count here; just re-check the caps between cards.
    const r = await runCard(card, { ...deps, governor: gov });
    results.push(r);
    if (gov) {
      const c = gov.check(deps.now());
      if (!c.ok) { tripReason = c.trip; break; }
    }
  }
  return {
    date: new Date(deps.now()).toISOString().slice(0, 10),
    cards: results,
    tokens: gov?.tokens ?? results.reduce((n, r) => n + (r.tokensUsed || 0), 0),
    costUsd: deps.costUsd ?? 0,
    tripReason,
  };
}
