// src/verifier.mjs
import { spawn } from 'node:child_process';
import { byteCap } from './lib.mjs';
import { fence, scrubSecrets } from './sanitize.mjs';

// Run the card's acceptance command OURSELVES as an argv spawn (never a shell).
// Pass = exit 0 within timeout. The agent's own "done" claim is never trusted.
export function runAcceptance(argv, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd });
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutSec * 1000);
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ pass: !timedOut && code === 0, code, stderrHead: err.split('\n').slice(0, 5).join('\n'), timedOut });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ pass: false, code: null, stderrHead: String(e.message), timedOut }); });
  });
}

// Cheap non-LLM cross-check: a net-negative "feature" diff is suspect (agent may
// have deleted the thing under test). Parses `git diff --shortstat`.
export function netLinesGutted(diffStat) {
  const ins = Number((diffStat.match(/(\d+) insertion/) || [])[1] || 0);
  const del = Number((diffStat.match(/(\d+) deletion/) || [])[1] || 0);
  return del > ins;
}

// LLM judge, fed only fenced/scrubbed diff text. Fail-closed: anything but a clear
// yes is treated as not-implemented by the caller.
export async function diffSanity({ goal, diffStat, diffExcerpt, engine }) {
  const prompt = [
    'You are judging whether a code change actually implements a goal or just deletes/guts code.',
    `GOAL: ${goal}`,
    `DIFF STAT: ${diffStat}`,
    fence('diff', byteCap(scrubSecrets(diffExcerpt), 12000)),
    'Answer strictly with a JSON object: {"implemented": true|false, "reason": "..."}.',
  ].join('\n\n');
  const r = await engine({ prompt });
  try {
    const m = r.text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m[0]);
    return { implemented: j.implemented === true, reason: String(j.reason || '') };
  } catch {
    return { implemented: false, reason: 'unparseable judge output (fail-closed)' };
  }
}
