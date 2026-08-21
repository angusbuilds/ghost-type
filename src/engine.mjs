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
      const ok = code === 0 && Boolean(p.assistantText);
      // A crash (nonzero exit, no agent message) yields NO result — so the watcher
      // classifies it as a transport 'errored' with a retry cap, not a soft 'stalled'
      // that loops (Codex re-audit #9).
      const crashed = code !== 0 && !p.assistantText;
      resolve({
        exitCode: code ?? 0,
        result: crashed ? null : { subtype: ok ? 'success' : 'error', result: text },
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
