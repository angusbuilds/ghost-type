// src/drive.mjs
// Haunt-mode drive loop: watch a live terminal pane, and when its agent goes idle, inject
// the next prompt (in his voice) via tmux send-keys. Safety first: never a blind Enter
// (two-step send), never type while the human is active, never type into a dead/changed
// pane. All side-effecting calls are injected so the logic is testable offline.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { writeNextPrompt } from './prompt-writer.mjs';
import { loadVoice, exemplarsFor } from './voice.mjs';
import { runEngine } from './engine.mjs';
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

// Two-step injection — type the text, pause, THEN Enter. Never a blind Enter.
export function injectPrompt(paneId, text, { sendKeys, delayMs = 400, sleep = async () => {} } = {}) {
  sendKeys(paneId, text);
  return Promise.resolve(sleep(delayMs)).then(() => sendKeys(paneId, 'Enter'));
}

export function realSendKeys(paneId, keys) {
  if (keys === 'Enter') tmux('send-keys', '-t', paneId, 'Enter');
  else tmux('send-keys', '-t', paneId, '-l', keys);   // -l = literal, no key-name interpretation
}
export function paneSnapshot(paneId, { runner = tmux } = {}) {
  try { return captureTail(runner('capture-pane', '-p', '-t', paneId)); } catch { return null; }
}
export function paneAlive(paneId, { runner = tmux } = {}) {
  try { return runner('list-panes', '-a', '-F', '#{pane_id}').split('\n').includes(paneId); } catch { return false; }
}
// Seconds since the last human keyboard/mouse input (macOS HIDIdleTime, in ns).
export function realHumanIdleSecs() {
  try {
    const m = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return m ? Number(m[1]) / 1e9 : Infinity;
  } catch { return Infinity; }
}

// Compose the next nudge for a LIVE session (no test to grade against — keep it moving
// toward the goal, in his voice, given what's on screen).
export async function composeLivePrompt({ goal, paneOutput, voice, engine }) {
  const card = { goal };
  return writeNextPrompt({
    card, diffTail: '', testTail: '', notesTail: '', transcriptTail: paneOutput,
    voiceProfile: voice.profile, exemplars: exemplarsFor(voice.bank, 'continue'),
    failure: null, engine,
  });
}

// One decision step. Returns the new state + snapshot; the loop owns timing and sleeping.
export async function driveStep({ paneId, goal, prev, deps }) {
  const { runner, sendKeys, humanIdleSecs, engine, voice, humanThreshold = 60, sleep } = deps;
  if (!paneAlive(paneId, { runner })) return { state: 'gone' };
  if (humanIdleSecs() < humanThreshold) return { state: 'paused', snapshot: prev };  // he's at the keyboard
  const cur = paneSnapshot(paneId, { runner });
  if (!isPaneIdle(prev, cur)) return { state: 'working', snapshot: cur };             // still producing output
  const prompt = await composeLivePrompt({ goal, paneOutput: cur, voice, engine });
  await injectPrompt(paneId, prompt, { sendKeys, sleep });
  return { state: 'injected', prompt, snapshot: cur };
}

// The loop: poll, and inject when idle, until the pane dies or the inject cap is hit.
export async function hauntDrive({ paneId, goal, deps, maxInjects = 20, pollMs = 5000 }) {
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  let prev = null, injects = 0;
  const injected = [];
  while (injects < maxInjects) {
    const r = await driveStep({ paneId, goal, prev, deps: { ...deps, sleep } });
    if (r.state === 'gone') return { reason: 'pane-gone', injects, injected };
    if (r.state === 'injected') { injects++; injected.push(r.prompt); prev = null; }  // reset so we wait for fresh output
    else prev = r.snapshot;
    await sleep(pollMs);
  }
  return { reason: 'max-injects', injects, injected };
}

export function defaultDriveDeps({ engine = 'claude' } = {}) {
  // The writer engine must be a CALLABLE that returns {text} — a read-only headless
  // claude -p that only composes the next prompt (it never touches the driven pane).
  const writerEngine = async ({ prompt }) => {
    const r = await runEngine({ cwd: os.homedir(), prompt, allowedTools: 'Read', maxTurns: 1, maxBudgetUsd: 1, env: buildSessionEnv() });
    return { text: r.text };
  };
  return { runner: tmux, sendKeys: realSendKeys, humanIdleSecs: realHumanIdleSecs, engine: writerEngine, voice: loadVoice() };
}
