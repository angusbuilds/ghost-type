// src/engine.mjs
// Parse the NDJSON stream from `claude -p --output-format stream-json --verbose`.
// Each line is one JSON event; the final `type:"result"` event carries the outcome,
// token usage, and total cost. We hand-parse to keep zero deps.
import { spawn } from 'node:child_process';
import { CLAUDE_BIN } from './lib.mjs';

export function parseStreamJson(text) {
  const events = [];
  let result = null;
  let assistantText = '';
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; } // skip non-JSON noise
    events.push(ev);
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) if (block.type === 'text') assistantText += block.text;
    }
    if (ev.type === 'result') result = ev;
  }
  const usage = result?.usage ?? null;
  return { events, result, usage, assistantText };
}

// NOTE: `--max-turns` is intentionally absent — it does not exist on claude v2.1.226.
// Turn/iteration limits are our job (spine loop + Governor). `--max-budget-usd` is the
// one native in-process cap and is always passed. maxTurns is accepted but unused here,
// kept in the signature so the card field has a home and a future CLI can use it.
export function runEngine({ cwd, prompt, allowedTools, maxTurns, maxBudgetUsd, env, bin }) {
  const exe = bin || CLAUDE_BIN;
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk',
    '--allowedTools', allowedTools,
    '--max-budget-usd', String(maxBudgetUsd),
  ];
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env: env || process.env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code) => {
      const parsed = parseStreamJson(out);
      resolve({
        exitCode: code ?? 0,
        result: parsed.result,
        usage: parsed.usage,
        text: parsed.assistantText || parsed.result?.result || err,
        raw: out,
      });
    });
    child.on('error', () => resolve({ exitCode: 1, result: null, usage: null, text: err || 'spawn error', raw: out }));
  });
}
