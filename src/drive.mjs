// src/drive.mjs
// Haunt-mode drive loop: watch a live terminal pane, and when its agent goes idle, inject
// the next prompt (in his voice) via tmux send-keys. Safety first: never a blind Enter
// (two-step send), never type while the human is active, never type into a dead/changed
// pane. All side-effecting calls are injected so the logic is testable offline.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { writeNextPrompt } from './prompt-writer.mjs';
import { loadVoice, exemplarsFor } from './voice.mjs';
import { runAgent } from './engine.mjs';
import { buildSessionEnv } from './env.mjs';

const TMUX = process.env.GHOST_TMUX_BIN || 'tmux';
const tmux = (...a) => execFileSync(TMUX, a, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();

// Last n non-empty lines of a captured pane.
export function captureTail(text, n = 40) {
  return String(text).split('\n').filter(l => l.trim()).slice(-n).join('\n');
}

// Output-stability idle signal: two identical consecutive snapshots = the agent stopped
// producing output. The loop controls the seconds between snapshots.
export function isPaneIdle(prev, cur) {
  return Boolean(cur) && prev === cur;
}

// Injected text must be a single, bounded, printable line — anything with an internal
// newline could submit a command before our delayed Enter (Codex C1). Returns null to reject.
export function sanitizeInjection(text) {
  if (typeof text !== 'string') return null;
  const firstLine = text.replace(/\r/g, '').split('\n')[0]
    .replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/g, '').trim();   // strip control + DEL/C1 + unicode line/para separators (round 31)
  if (!firstLine || firstLine.length > 600) return null;
  return firstLine;
}

// Two-step injection — type the text, pause, THEN Enter. Never a blind Enter. `beforeEnter`
// is a last-instant guard re-run AFTER the pause: if the world changed during the delay
// (agent exited to a shell, human returned), we skip Enter rather than submit into a shell
// (round 4 #3). The already-typed text is left unsubmitted — the safe failure.
export async function injectPrompt(paneId, text, { sendKeys, delayMs = 400, sleep = async () => {}, beforeEnter, onAbort } = {}) {
  sendKeys(paneId, text);
  await sleep(delayMs);
  if (beforeEnter && !beforeEnter()) { if (onAbort) onAbort(); return false; }
  sendKeys(paneId, 'Enter');
  return true;
}

export function realSendKeys(paneId, keys) {
  // 'Enter' and control keys (C-u) go as key NAMES; everything else is literal text (-l).
  if (keys === 'Enter' || /^C-[a-z]$/.test(keys)) tmux('send-keys', '-t', paneId, keys);
  else tmux('send-keys', '-t', paneId, '-l', keys);
}
export function paneSnapshot(paneId, { runner = tmux } = {}) {
  try { return captureTail(runner('capture-pane', '-p', '-t', paneId)); } catch { return null; }
}
export function paneAlive(paneId, { runner = tmux } = {}) {
  try { return runner('list-panes', '-a', '-F', '#{pane_id}').split('\n').includes(paneId); } catch { return false; }
}

// The pane's current foreground command name (e.g. "claude", "node", "zsh").
export function paneCommand(paneId, { runner = tmux } = {}) {
  try { return runner('display-message', '-p', '-t', paneId, '#{pane_current_command}').trim(); } catch { return ''; }
}

// Resolve the FULL argv of the pane's foreground process group via its tty. This is how we
// tell `node /path/to/claude` (a real agent) from `node build.js` (not one) — the command
// NAME alone can't (round 4 #3). Fails to '' (→ not-an-agent) if we can't read it.
export function realForegroundArgv(tty) {
  const dev = String(tty).replace(/^\/dev\//, '');
  if (!dev) return '';
  const out = execFileSync('ps', ['-t', dev, '-o', 'stat=,command='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (m && m[1].includes('+')) return m[2];   // '+' = foreground process group
  }
  return '';
}
export function paneForegroundArgv(paneId, { runner = tmux, ps = realForegroundArgv } = {}) {
  try {
    const tty = runner('display-message', '-p', '-t', paneId, '#{pane_tty}').trim();
    return tty ? ps(tty) : '';
  } catch { return ''; }
}

// Three-way, fail-closed classification of the pane's foreground:
//  - agent  → a coding agent is waiting for input (safe to inject)
//  - shell  → an interactive shell prompt (agent exited → terminate the drive)
//  - other  → a subprocess (agent running a tool) or unknown → keep polling, never inject
// Generic runtimes (node/python/bun/deno) are agents ONLY if their argv names an agent —
// otherwise they're "other" (a tool the agent spawned), not a green light to type.
const DIRECT_AGENT = /^(claude|codex|aider)$/i;
const RUNTIME = /^(node|python3?|bun|deno)$/i;
const AGENT_IN_ARGV = /(^|[\/\s])(claude|codex|aider)(\s|$)/i;
const SHELL_CMD = /^-?(bash|zsh|sh|ksh|csh|tcsh|fish|dash)$/i;

export function foregroundIsAgent(paneId, opts = {}) {
  const cmd = paneCommand(paneId, opts);
  if (DIRECT_AGENT.test(cmd)) return true;
  if (RUNTIME.test(cmd)) return AGENT_IN_ARGV.test(paneForegroundArgv(paneId, opts));   // confirm via argv, else fail closed
  return false;
}
// A genuine interactive shell prompt — the definitive "the agent has exited" signal. A
// subprocess like `node`/`git` is NOT a shell, so a running tool never false-terminates.
export function foregroundIsShell(paneId, opts = {}) { return SHELL_CMD.test(paneCommand(paneId, opts)); }
// Seconds since the last human keyboard/mouse input (macOS HIDIdleTime, in ns).
// Fail CLOSED (Codex H2): if the probe can't read idle time, assume the human IS active
// (return 0) so we pause rather than type over them.
export function realHumanIdleSecs() {
  try {
    const m = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return m ? Number(m[1]) / 1e9 : 0;
  } catch { return 0; }
}

// Compose the next nudge for a LIVE session (no test to grade against — keep it moving
// toward the goal, in his voice, given what's on screen).
export async function composeLivePrompt({ goal, paneOutput, voice, engine }) {
  const card = { goal };
  try {
    return await writeNextPrompt({
      card, diffTail: '', testTail: '', notesTail: '', transcriptTail: paneOutput,
      voiceProfile: voice.profile, exemplars: exemplarsFor(voice.bank, 'continue'),
      failure: null, engine,
    });
  } catch (e) {
    // writeNextPrompt throws SHIELD_HIT when the pane text trips an injection SIGNALS pattern — and an
    // agent working on THIS repo prints exactly such phrases ("system prompt", "you are now") as benign
    // narration. In a LIVE drive there is no card to park, so degrade to the SAFE goal (our own string,
    // never the pane text — the shield's job is fully satisfied) and keep driving, mirroring the
    // engineFailed→goal fallback in writeNextPrompt and spine's two catch sites. Uncaught, one benign
    // snapshot unwound to main().catch → exit 1 and killed the whole overnight drive (round 33 HIGH).
    if (e && e.message === 'SHIELD_HIT') return goal;
    throw e;
  }
}

// One decision step. Returns the new state + snapshot; the loop owns timing and sleeping.
export async function driveStep({ paneId, goal, prev, deps }) {
  const { runner, sendKeys, humanIdleSecs, engine, voice, humanThreshold = 60, sleep } = deps;
  if (!paneAlive(paneId, { runner })) return { state: 'gone' };
  if (foregroundIsShell(paneId, { runner })) return { state: 'shell' };                // agent exited to a prompt — terminal (#5)
  if (!foregroundIsAgent(paneId, { runner })) return { state: 'working', snapshot: prev }; // a tool is running — never type into it
  if (humanIdleSecs() < humanThreshold) return { state: 'paused', snapshot: prev };    // he's at the keyboard
  const cur = paneSnapshot(paneId, { runner });
  if (!isPaneIdle(prev, cur)) return { state: 'working', snapshot: cur };              // still producing output

  const raw = await composeLivePrompt({ goal, paneOutput: cur, voice, engine });
  const prompt = sanitizeInjection(raw);
  if (!prompt) return { state: 'rejected', snapshot: cur };                            // empty/unsafe text (C1)

  // The world may have changed during the async model call — recheck EVERYTHING right
  // before sending (Codex H1), with a DISTINCT state per reason so the drive log is legible.
  if (!paneAlive(paneId, { runner })) return { state: 'gone' };
  if (foregroundIsShell(paneId, { runner })) return { state: 'shell' };
  if (!foregroundIsAgent(paneId, { runner })) return { state: 'working', snapshot: cur };
  if (humanIdleSecs() < humanThreshold) return { state: 'paused', snapshot: cur };
  if (paneSnapshot(paneId, { runner }) !== cur) return { state: 'working', snapshot: cur };

  // Re-run the safety guard ONCE MORE after the type→Enter pause, so an agent that exits during the
  // 400ms delay can't have our Enter land in its shell (round 4 #3). NB: do NOT compare the pane
  // snapshot to `cur` here — a normal Claude/Codex TUI echoes the text we just typed, so the pane
  // always differs after typing and Enter would never be sent, stranding the prompt. Human
  // interference during the pause is caught by the humanIdleSecs check, shell-exit by the shell
  // check; the snapshot equality was both redundant and echo-breaking (round 27).
  const beforeEnter = () =>
    paneAlive(paneId, { runner }) && !foregroundIsShell(paneId, { runner }) &&
    foregroundIsAgent(paneId, { runner }) && humanIdleSecs() >= humanThreshold;
  // If we aborted BECAUSE the agent exited to a shell, our already-typed text is now sitting at
  // a shell prompt where a later human Enter could run it — clear the line with Ctrl-U. Only do
  // this for a confirmed shell; never send control keys into a live agent TUI (round 5 H3).
  const onAbort = () => { if (paneAlive(paneId, { runner }) && foregroundIsShell(paneId, { runner })) sendKeys(paneId, 'C-u'); };
  const sent = await injectPrompt(paneId, prompt, { sendKeys, sleep, beforeEnter, onAbort });
  if (!sent) return { state: 'aborted', snapshot: cur };
  return { state: 'injected', prompt, snapshot: cur };
}

// The loop: poll, and inject only after the pane has been stable for `minStable`
// consecutive polls (Codex H2 — output-stability across a single pair is too weak a
// signal; an agent mid-tool-call looks identical for one interval). Only then does
// driveStep run its fresh recheck + sanitize + inject.
export async function hauntDrive({ paneId, goal, deps, maxInjects = 20, pollMs = 5000, minStable = 2 }) {
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const runner = deps.runner;
  let prev = null, stable = 0, injects = 0;
  const injected = [];
  while (injects < maxInjects) {
    if (!paneAlive(paneId, { runner })) return { reason: 'pane-gone', injects, injected };
    // Check for an exited agent EVERY poll, before stability — an empty shell pane never
    // becomes "stable non-empty", so a stability-gated check alone would poll forever (#5).
    if (foregroundIsShell(paneId, { runner })) return { reason: 'agent-exited', injects, injected };
    const cur = paneSnapshot(paneId, { runner });
    if (cur && cur === prev) stable += 1; else stable = 0;
    prev = cur;

    if (stable >= minStable) {                       // genuinely idle across several polls
      const r = await driveStep({ paneId, goal, prev: cur, deps: { ...deps, sleep } });
      if (r.state === 'gone') return { reason: 'pane-gone', injects, injected };
      if (r.state === 'shell') return { reason: 'agent-exited', injects, injected };   // terminal — don't spend forever (#5)
      if (r.state === 'injected') { injects += 1; injected.push(r.prompt); prev = null; stable = 0; }
      // paused / working / rejected / aborted → keep polling, don't count it
    }
    await sleep(pollMs);
  }
  return { reason: 'max-injects', injects, injected };
}

export function defaultDriveDeps({ engine = 'claude' } = {}) {
  // The writer engine must be a CALLABLE that returns {text} — a READ-ONLY headless agent
  // that only composes the next prompt (it never touches the driven pane). Honor the chosen
  // engine (round 4 #5): Codex gets its read-only sandbox, Claude gets Read-only tools.
  const writerEngine = async ({ prompt }) => {
    const opts = engine === 'codex'
      ? { engine: 'codex', cwd: os.homedir(), prompt, sandbox: 'read-only', env: buildSessionEnv([], process.env, 'codex') }
      : { engine: 'claude', cwd: os.homedir(), prompt, allowedTools: 'Read', maxTurns: 1, maxBudgetUsd: 1, env: buildSessionEnv([], process.env, 'claude') };
    // Return the FULL result (incl. exitCode) so the writer's transport-failure guard fires here
    // too — otherwise a "spawn error" string becomes an injected prompt (round 7 Medium#1).
    return runAgent(opts);
  };
  return { runner: tmux, sendKeys: realSendKeys, humanIdleSecs: realHumanIdleSecs, engine: writerEngine, voice: loadVoice() };
}
