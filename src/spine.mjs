// src/spine.mjs
import { classifyOutcome } from './watcher.mjs';
import { log } from './lib.mjs';

// The Milestone-0 driver for ONE card. Loops: run engine → classify → on done, verify →
// pass ships, fail feeds the prompt-writer for another try; rate-limit sleeps; network
// backs off. Parks after maxIterations or a shield hit. deps is the test seam.
export async function runCard(card, deps) {
  const {
    now, makeClone, commit, gitDiff, runEngine, verify, writeNextPrompt,
    sleepUntil = async () => {}, voiceProfile = 'direct, terse, verification-driven', exemplars = [],
  } = deps;

  const clonePath = makeClone(card.repoPath, card.branch.replace(/[^\w.-]/g, '_'));
  const promptsWritten = [];
  let prompt = card.goal;
  let lastTestOutput = '';
  let lastFailure = null;
  let iterations = 0;
  let netBackoffs = 0;

  while (iterations < card.maxIterations) {
    iterations += 1;
    const eng = await runEngine({ cwd: clonePath, prompt, card });
    const outcome = classifyOutcome({ exitCode: eng.exitCode, result: eng.result, text: eng.text, nowMs: now() });

    if (outcome.state === 'rate-limited') {
      iterations -= 1;                       // not a real attempt — don't spend the budget
      await sleepUntil(outcome.resetAtMs);
      continue;
    }
    if (outcome.state === 'network') {
      iterations -= 1;
      if (++netBackoffs > 3) { return park(card, 'network unreachable after retries', iterations, lastTestOutput, promptsWritten); }
      await sleepUntil(now() + 30_000);
      continue;
    }

    // done or stalled → try to verify what's on disk (agent claims are never trusted)
    const v = await verify(card, clonePath, { gitDiff });
    lastTestOutput = v.detail.testOutput;
    if (v.pass) {
      commit(clonePath, card.branch);
      log({ evt: 'card-shipped', project: card.project, iterations });
      return { project: card.project, goal: card.goal, outcome: 'shipped', mergeReady: true, whyLine: 'acceptance passed', iterations, branch: card.branch, testOutput: lastTestOutput, promptsWritten };
    }

    // failed verification → write the next prompt (unless out of iterations)
    lastFailure = { code: 1, stderrHead: v.detail.testOutput };
    if (iterations >= card.maxIterations) break;
    try {
      const diff = gitDiff(clonePath);
      prompt = await writeNextPrompt({
        card, diffTail: diff.excerpt, testTail: v.detail.testOutput, notesTail: '',
        transcriptTail: eng.text, voiceProfile, exemplars, failure: lastFailure,
        engine: async ({ prompt }) => runEngine({ cwd: clonePath, prompt, card, writer: true }),
      });
      promptsWritten.push(prompt);
    } catch (e) {
      if (e.message === 'SHIELD_HIT') return park(card, 'shield hit — injection signal in session output', iterations, lastTestOutput, promptsWritten, e.patterns);
      throw e;
    }
  }
  return park(card, `no pass after ${card.maxIterations} iterations`, iterations, lastTestOutput, promptsWritten);
}

function park(card, why, iterations, testOutput, promptsWritten, patterns) {
  log({ evt: 'card-parked', project: card.project, why, patterns });
  return { project: card.project, goal: card.goal, outcome: 'parked', mergeReady: false, whyLine: why, iterations, branch: card.branch, testOutput, promptsWritten };
}

export async function runNight(cards, deps) {
  const results = [];
  for (const card of cards) results.push(await runCard(card, deps));
  return {
    date: new Date(deps.now()).toISOString().slice(0, 10),
    cards: results,
    tokens: deps.governor?.tokens ?? 0,
    costUsd: deps.costUsd ?? 0,
    tripReason: deps.governor?.check(deps.now()).trip ?? null,
  };
}
