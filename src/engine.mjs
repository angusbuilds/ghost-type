// src/engine.mjs
// Parse the NDJSON stream from `claude -p --output-format stream-json --verbose`.
// Each line is one JSON event; the final `type:"result"` event carries the outcome,
// token usage, and total cost. We hand-parse to keep zero deps.
import { spawn } from 'node:child_process';
import { CLAUDE_BIN, CODEX_BIN } from './lib.mjs';

// Guardrails shared by both engine adapters (round 5 H4):
//  - cap each captured stream so a runaway agent can't exhaust memory;
//  - a wall-clock deadline that KILLS THE WHOLE PROCESS GROUP, so a single call can't run past
//    the night deadline / budget and starve cleanup + reporting.
const MAX_STREAM_BYTES = 8 * 1024 * 1024;      // 8MB/stream — a real session is far under this
const DEFAULT_CALL_TIMEOUT_MS = 45 * 60 * 1000; // hard ceiling for one engine call

function capped() {
  let buf = '', bytes = 0;
  return {
    push: (d) => { if (bytes < MAX_STREAM_BYTES) { buf += d; bytes += d.length; } },
    get: () => buf,
  };
}
function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); }   // negative pid → the detached process group
  catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

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
export function runEngine({ cwd, prompt, allowedTools, maxTurns, maxBudgetUsd, env, bin, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  const exe = bin || CLAUDE_BIN;
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk',
    '--allowedTools', allowedTools,
    '--max-budget-usd', String(maxBudgetUsd),
  ];
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env: env || process.env, detached: true });
    const out = capped(), err = capped();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseStreamJson(out.get());
      // A timeout, signal (null), or nonzero exit is a transport failure so the watcher sees it.
      const exitCode = timedOut ? 1 : (code == null ? 1 : code);
      resolve({
        exitCode,
        // A nonzero/signal exit is a transport failure — drop the result so the watcher
        // classifies it 'errored' (retry-capped), not a soft 'stalled' (round 4 #4).
        result: exitCode === 0 ? parsed.result : null,
        // ...but keep the real cost as independent transport metadata, so a crash-after-result
        // call is still metered by the dollar governor (round 5 M6).
        costUsd: parsed.result?.total_cost_usd || 0,
        usage: parsed.usage,
        text: timedOut ? `engine call exceeded ${Math.round(timeoutMs / 1000)}s — killed`
                       : (parsed.assistantText || parsed.result?.result || err.get()),
        raw: out.get(),
      });
    });
    child.on('error', () => { clearTimeout(timer); resolve({ exitCode: 1, result: null, costUsd: 0, usage: null, text: err.get() || 'spawn error', raw: out.get() }); });
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
export function runCodex({ cwd, prompt, sandbox = 'workspace-write', model, env, bin, timeoutMs = DEFAULT_CALL_TIMEOUT_MS }) {
  const exe = bin || CODEX_BIN;
  const args = ['exec', '--json', '-C', cwd, '--sandbox', sandbox, '--skip-git-repo-check', '-c', 'approval_policy="never"'];
  if (model) args.push('-m', model);
  args.push(prompt);
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env: env || process.env, detached: true });
    const out = capped(), err = capped();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('close', (code) => {
      clearTimeout(timer);
      const p = parseCodexStream(out.get());
      const text = p.assistantText || err.get();
      // ANY nonzero exit, signal (code === null), OR a timeout is a transport failure → no result,
      // so the watcher classifies it 'errored' (retry-capped), never a soft looping 'stalled'.
      // The text is still returned so rate/network detection can read it (Codex round 3 #6).
      const exitCode = timedOut ? 1 : (code == null ? 1 : code);
      const crashed = exitCode !== 0;
      resolve({
        exitCode,
        result: crashed ? null : { subtype: p.assistantText ? 'success' : 'error', result: text },
        usage: p.tokens ? {
          input_tokens: p.tokens.input_tokens ?? p.tokens.input ?? 0,
          output_tokens: p.tokens.output_tokens ?? p.tokens.output ?? 0,
        } : null,
        text: timedOut ? `codex call exceeded ${Math.round(timeoutMs / 1000)}s — killed` : text,
        raw: out.get(),
      });
    });
    child.on('error', () => { clearTimeout(timer); resolve({ exitCode: 1, result: null, usage: null, text: err.get() || 'spawn error', raw: out.get() }); });
  });
}

// Dispatch by engine name so callers pass a card's chosen engine.
export function runAgent({ engine = 'claude', ...opts }) {
  return engine === 'codex' ? runCodex(opts) : runEngine(opts);
}
