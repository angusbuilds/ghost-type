// src/engine.mjs
// Parse the NDJSON stream from `claude -p --output-format stream-json --verbose`.
// Each line is one JSON event; the final `type:"result"` event carries the outcome,
// token usage, and total cost. We hand-parse to keep zero deps.
import { spawn } from 'node:child_process';
import { CLAUDE_BIN, CODEX_BIN } from './lib.mjs';
import { sandboxWriteConfine } from './sandbox.mjs';

// Guardrails shared by both engine adapters (round 5 H4):
//  - cap each captured stream so a runaway agent can't exhaust memory;
//  - a wall-clock deadline that KILLS THE WHOLE PROCESS GROUP, so a single call can't run past
//    the night deadline / budget and starve cleanup + reporting.
const MAX_STREAM_BYTES = 8 * 1024 * 1024;      // 8MB/stream — a real session is far under this
export const DEFAULT_CALL_TIMEOUT_MS = 45 * 60 * 1000; // hard ceiling for one engine call

// Head + rolling TAIL, not just a head. The terminal accounting event (Claude's `result`,
// Codex's `token_count`) arrives at the END of the stream, so a head-only cap would discard
// the final cost/usage on a large session and undercount the governor (round 6 #6). A session
// under half the budget is captured whole; beyond that we keep the first and last halves.
export function capped(maxBytes = MAX_STREAM_BYTES) {
  const half = Math.max(1, Math.floor(maxBytes / 2));
  let head = '', headDone = false, tail = '';
  return {
    push: (d) => {
      const s = String(d);
      if (!headDone) { head += s; if (Buffer.byteLength(head) >= half) headDone = true; }
      else { tail += s; if (tail.length > half) tail = tail.slice(-half); }   // keep the END (final event)
    },
    get: () => (headDone && tail) ? head + '\n' + tail : head,
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
export function runEngine({ cwd, prompt, allowedTools, maxTurns, maxBudgetUsd, env, bin, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, sandboxClone }) {
  const exe = bin || CLAUDE_BIN;
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk',
    '--allowedTools', allowedTools,
    '--max-budget-usd', String(maxBudgetUsd),
  ];
  // When sandboxing is on, confine the coding session's WRITES to the clone (network stays up
  // for the API) — bare Edit/Write otherwise reach the whole host (round 8 Critical).
  const [cmd, ...cmdArgs] = sandboxClone ? sandboxWriteConfine([exe, ...args], sandboxClone) : [exe, ...args];
  return new Promise((resolve) => {
    // IGNORE stdin — with a non-TTY stdin `codex exec` prints "Reading additional input from
    // stdin..." and blocks forever waiting for it (every call hung until the timeout). /dev/null
    // gives immediate EOF so the agent runs with just the prompt arg. Harmless for claude -p,
    // which reads its prompt from the flag, not stdin (round 11).
    const child = spawn(cmd, cmdArgs, { cwd, env: env || process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = capped(), err = capped();
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    // Settle at the deadline INDEPENDENTLY — don't wait for 'close', which a detached grandchild
    // holding our stdout can delay indefinitely (round 7 High#1). Kill the group, detach, resolve.
    const timer = setTimeout(() => {
      killGroup(child);
      try { child.unref(); child.stdout.destroy(); child.stderr.destroy(); } catch { /* already gone */ }
      const parsed = parseStreamJson(out.get());
      finish({ exitCode: 1, result: null, costUsd: parsed.result?.total_cost_usd || 0, usage: parsed.usage,
        text: `engine call exceeded ${Math.round(timeoutMs / 1000)}s — killed`, raw: out.get() });
    }, timeoutMs);
    child.on('close', (code) => {
      const parsed = parseStreamJson(out.get());
      const exitCode = code == null ? 1 : code;   // signal → nonzero so the watcher sees a failure
      finish({
        exitCode,
        // A nonzero/signal exit is a transport failure — drop the result so the watcher
        // classifies it 'errored' (retry-capped), not a soft 'stalled' (round 4 #4).
        result: exitCode === 0 ? parsed.result : null,
        // ...but keep the real cost as independent transport metadata, so a crash-after-result
        // call is still metered by the dollar governor (round 5 M6).
        costUsd: parsed.result?.total_cost_usd || 0,
        usage: parsed.usage,
        text: parsed.assistantText || parsed.result?.result || err.get(),
        raw: out.get(),
      });
    });
    child.on('error', () => finish({ exitCode: 1, result: null, costUsd: 0, usage: null, text: err.get() || 'spawn error', raw: out.get() }));
  });
}

// ---------- Codex CLI adapter ----------
// `codex exec --json` emits JSONL events; the final assistant text is the last
// `agent_message` event (matching the proven codex-bridge parse on this machine).
export function parseCodexStream(text) {
  const events = [];
  let assistantText = '', errorMsg = '', tokens = null, turnCompleted = false, turnFailed = false;
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    events.push(ev);
    // Current schema (codex 0.148+, verified against the live CLI): assistant text and usage are
    // NESTED inside item.completed / turn.completed — the old top-level shape parsed nothing (round 8).
    if (ev.type === 'item.completed' && ev.item) {
      if (ev.item.type === 'agent_message' && typeof ev.item.text === 'string') assistantText = ev.item.text;   // last wins
      // item errors are mostly benign warnings (e.g. "skill descriptions were shortened") — keep
      // for diagnostics but DON'T treat as a turn failure; only `turn.failed` is a real failure (round 11).
      if (ev.item.type === 'error' && typeof ev.item.message === 'string') errorMsg = ev.item.message;
    }
    if (ev.type === 'turn.completed') { turnCompleted = true; if (ev.usage) tokens = ev.usage; }
    if (ev.type === 'turn.failed') { turnFailed = true; errorMsg = ev.error?.message || 'codex turn failed'; }
    // Legacy schema (older codex) — kept for backward compatibility.
    if (ev.type === 'agent_message' && typeof ev.text === 'string') assistantText = ev.text;
    if (ev.type === 'token_count' || ev.type === 'usage') tokens = ev;
  }
  return { events, assistantText, errorMsg, tokens, turnCompleted, turnFailed };
}

// Drive Codex headless in the isolated clone. Returns the SAME shape as runEngine so the
// spine/watcher work unchanged: a synthesized result.subtype of success|error.
// Our OS write-confine only wraps CODING calls — a read-only writer keeps codex's own read-only
// sandbox (which works standalone and needs no host write access).
const codexOsWrapped = (sandbox, sandboxClone) => Boolean(sandboxClone) && sandbox !== 'read-only';

// Build the `codex exec` argv. When WE wrap codex in the OS sandbox (a coding call with sandboxClone),
// codex must NOT also apply its own Seatbelt sandbox — a nested sandbox-exec silently fails to write
// (the turn "completes" but no file lands). Use danger-full-access there and let our OS write-confine
// be the confinement (round 13). Read-only writer calls are unaffected (they keep codex read-only).
export function codexArgs({ cwd, sandbox = 'workspace-write', model, prompt, sandboxClone }) {
  const effSandbox = codexOsWrapped(sandbox, sandboxClone) ? 'danger-full-access' : sandbox;
  const args = ['exec', '--json', '-C', cwd, '--sandbox', effSandbox, '--skip-git-repo-check', '-c', 'approval_policy="never"'];
  if (model) args.push('-m', model);
  args.push(prompt);
  return args;
}

export function runCodex({ cwd, prompt, sandbox = 'workspace-write', model, env, bin, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, sandboxClone }) {
  const exe = bin || CODEX_BIN;
  const args = codexArgs({ cwd, sandbox, model, prompt, sandboxClone });
  const [cmd, ...cmdArgs] = codexOsWrapped(sandbox, sandboxClone) ? sandboxWriteConfine([exe, ...args], sandboxClone) : [exe, ...args];
  return new Promise((resolve) => {
    // IGNORE stdin — with a non-TTY stdin `codex exec` prints "Reading additional input from
    // stdin..." and blocks forever waiting for it (every call hung until the timeout). /dev/null
    // gives immediate EOF so the agent runs with just the prompt arg. Harmless for claude -p,
    // which reads its prompt from the flag, not stdin (round 11).
    const child = spawn(cmd, cmdArgs, { cwd, env: env || process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = capped(), err = capped();
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    // Settle at the deadline independently of 'close' (round 7 High#1).
    const timer = setTimeout(() => {
      killGroup(child);
      try { child.unref(); child.stdout.destroy(); child.stderr.destroy(); } catch { /* already gone */ }
      finish({ exitCode: 1, result: null, usage: null, text: `codex call exceeded ${Math.round(timeoutMs / 1000)}s — killed`, raw: out.get() });
    }, timeoutMs);
    child.on('close', (code) => {
      const p = parseCodexStream(out.get());
      // On a turn.failed, prefer the ERROR message so the failure REASON (e.g. a usage-limit phrase)
      // reaches the watcher for rate-limit classification — even if the turn emitted some assistant
      // text before failing, which would otherwise mask it (round 29, refining round 28 #4).
      const text = p.turnFailed ? (p.errorMsg || err.get()) : (p.assistantText || p.errorMsg || err.get());
      // ANY nonzero exit or signal (code === null) is a transport failure → no result, so the
      // watcher classifies it 'errored' (retry-capped), never a soft looping 'stalled'. The text
      // is still returned so rate/network detection can read it (Codex round 3 #6).
      // A coding turn succeeds via TOOL CALLS and often has no final agent_message, so success is
      // exit 0 + turn.completed + no turn.failed — NOT the presence of assistant text (round 11).
      // A truncated/protocol-invalid turn (exit 0 but NO turn.completed) or a turn.failed is NOT
      // success; force a nonzero exit so the watcher classifies it 'errored', never a soft 'stalled' (round 12).
      const rawExit = code == null ? 1 : code;
      const ok = rawExit === 0 && p.turnCompleted && !p.turnFailed;
      const exitCode = ok ? 0 : (rawExit === 0 ? 1 : rawExit);
      // A `turn.failed` is a STRUCTURED provider failure (e.g. a usage limit), NOT a transport crash —
      // give it a result so the watcher classifies it as rate-limited/network, not a generic 'errored'
      // that just retries and parks. Reserve result:null for a real crash with no terminal event (round 28 #4).
      const structuredFail = !ok && p.turnFailed;
      finish({
        exitCode,
        result: ok ? { subtype: 'success', result: text || 'codex turn completed' }
              : structuredFail ? { subtype: 'error', is_error: true, result: text || p.errorMsg || 'codex turn failed' }
              : null,
        usage: p.tokens ? {
          input_tokens: p.tokens.input_tokens ?? p.tokens.input ?? 0,
          output_tokens: p.tokens.output_tokens ?? p.tokens.output ?? 0,
        } : null,
        text,
        raw: out.get(),
      });
    });
    child.on('error', () => finish({ exitCode: 1, result: null, usage: null, text: err.get() || 'spawn error', raw: out.get() }));
  });
}

// Dispatch by engine name so callers pass a card's chosen engine.
export function runAgent({ engine = 'claude', ...opts }) {
  return engine === 'codex' ? runCodex(opts) : runEngine(opts);
}
