// src/engine.mjs
// Parse the NDJSON stream from `claude -p --output-format stream-json --verbose`.
// Each line is one JSON event; the final `type:"result"` event carries the outcome,
// token usage, and total cost. We hand-parse to keep zero deps.
import { spawn } from 'node:child_process';
import { CLAUDE_BIN, CODEX_BIN } from './lib.mjs';

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
      const exitCode = code == null ? 1 : code;   // signal (null) → nonzero so the watcher sees a failure
      resolve({
        exitCode,
        // A nonzero/signal exit is a transport failure — drop the result so the watcher
        // classifies it 'errored' (retry-capped), not a soft 'stalled' (round 4 #4).
        result: exitCode === 0 ? parsed.result : null,
        usage: parsed.usage,
        text: parsed.assistantText || parsed.result?.result || err,
        raw: out,
      });
    });
    child.on('error', () => resolve({ exitCode: 1, result: null, usage: null, text: err || 'spawn error', raw: out }));
  });
}

// ---------- Codex CLI adapter ----------
// `codex exec --json` emits JSONL events; the final assistant text is the last
// `agent_message` event (matching the proven codex-bridge parse on this machine).
export function parseCodexStream(text) {
  const events = [];
  let assistantText = '';
  let tokens = null;
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    events.push(ev);
    if (ev.type === 'agent_message' && typeof ev.text === 'string') assistantText = ev.text;   // last wins
    if (ev.type === 'token_count' || ev.type === 'usage') tokens = ev;
  }
  return { events, assistantText, tokens };
}

// Drive Codex headless in the isolated clone. Returns the SAME shape as runEngine so the
// spine/watcher work unchanged: a synthesized result.subtype of success|error.
export function runCodex({ cwd, prompt, sandbox = 'workspace-write', model, env, bin }) {
  const exe = bin || CODEX_BIN;
  const args = ['exec', '--json', '-C', cwd, '--sandbox', sandbox, '--skip-git-repo-check', '-c', 'approval_policy="never"'];
  if (model) args.push('-m', model);
  args.push(prompt);
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env: env || process.env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', (code) => {
      const p = parseCodexStream(out);
      const text = p.assistantText || err;
      // ANY nonzero exit OR a signal (code === null) is a transport failure → no result, so
      // the watcher classifies it 'errored' (retry-capped), never a soft looping 'stalled'.
      // The text is still returned so rate/network detection can read it (Codex round 3 #6).
      const exitCode = code == null ? 1 : code;
      const crashed = exitCode !== 0;
      resolve({
        exitCode,
        result: crashed ? null : { subtype: p.assistantText ? 'success' : 'error', result: text },
        usage: p.tokens ? {
          input_tokens: p.tokens.input_tokens ?? p.tokens.input ?? 0,
          output_tokens: p.tokens.output_tokens ?? p.tokens.output ?? 0,
        } : null,
        text,
        raw: out,
      });
    });
    child.on('error', () => resolve({ exitCode: 1, result: null, usage: null, text: err || 'spawn error', raw: out }));
  });
}

// Dispatch by engine name so callers pass a card's chosen engine.
export function runAgent({ engine = 'claude', ...opts }) {
  return engine === 'codex' ? runCodex(opts) : runEngine(opts);
}
