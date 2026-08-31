// src/run.mjs
// `ghost run`: driving with NO existing terminal. Ghost Type creates its own detached tmux
// session in the project directory, boots the agent inside it, waits until the pane's
// foreground genuinely IS the agent (same fail-closed classifier the drive loop trusts),
// and only then hands the pane to a detached drive. The tmux server keeps it alive with
// every window closed; `ghost open` attaches a Terminal window for peeking. All side
// effects are injected; the CLI wires the real tmux/spawn versions.
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { joinSessionName } from './sessions.mjs';
import { foregroundIsAgent } from './drive.mjs';

export async function runInBackground({ dir, goal, engine, agentCommand }, deps) {
  const { sessionExists, tmuxNewSession, typeIntoPane, waitForAgent, spawnDrive, killSession, sleep } = deps;
  const cleanGoal = String(goal || '').trim();
  if (!cleanGoal) return { ok: false, reason: 'a goal is required — ghost run "<goal>"' };

  let session = joinSessionName(dir);
  for (let n = 2; sessionExists(session); n++) session = `${joinSessionName(dir)}-${n}`;

  const paneId = tmuxNewSession(session, dir);
  if (!paneId) return { ok: false, reason: 'tmux could not create the session' };

  typeIntoPane(paneId, agentCommand);
  await sleep(400);
  if (!(await waitForAgent(paneId))) {
    // A pane that never became an agent must not linger half-born — and it must NEVER be
    // driven: the drive loop would classify it correctly anyway, but why let it try.
    if (killSession) killSession(session);
    return { ok: false, reason: `${agentCommand} never became ready in the new session — nothing is running` };
  }

  spawnDrive(paneId, cleanGoal, engine);
  return { ok: true, session, paneId };
}

// ---------- real deps ----------
const tmux = (...a) => execFileSync('tmux', a, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();

export function realRunDeps({ ghostBin }) {
  return {
    sessionExists: (name) => { try { execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }); return true; } catch { return false; } },
    tmuxNewSession: (name, dir) => {
      tmux('new-session', '-d', '-s', name, '-c', dir);
      return tmux('list-panes', '-t', name, '-F', '#{pane_id}').trim().split('\n')[0] || '';
    },
    // send-keys -l for the command text, then a real Enter — the same two-step the drive
    // loop uses, into a pane only we know about.
    typeIntoPane: (paneId, line) => { tmux('send-keys', '-t', paneId, '-l', line); tmux('send-keys', '-t', paneId, 'Enter'); },
    waitForAgent: async (paneId, { timeoutMs = 45_000, pollMs = 800 } = {}) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        try { if (foregroundIsAgent(paneId)) return true; } catch { /* keep polling */ }
        await new Promise(r => setTimeout(r, pollMs));
      }
      return false;
    },
    spawnDrive: (paneId, goal, engine) => {
      const child = spawn(process.execPath, [ghostBin, 'drive', '--engine', engine, paneId, goal], {
        detached: true, stdio: 'ignore',
      });
      child.unref();
    },
    killSession: (name) => { try { tmux('kill-session', '-t', name); } catch { /* already gone */ } },
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  };
}

// `ghost open <session>`: a Terminal window attached to the background session, for
// peeking at what the ghost is doing. Best-effort — the drive doesn't need it.
export function openInTerminal(session) {
  const script = `tell application "Terminal"
    activate
    do script "tmux attach -t ${session.replace(/[^A-Za-z0-9_-]/g, '')}"
  end tell`;
  execFileSync('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
}
