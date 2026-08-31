// src/adopt.mjs
// One-click adoption of a live Terminal.app tab into the driveable (tmux) world. An idle
// tab gets `ghost join` scripted into it. A tab running a coding agent gets the exact
// sequence a human does by hand: Ctrl-C (SIGINT ×2 — claude asks for the second), wait for
// the shell to come back, join, then relaunch the SAME agent command + --continue so the
// conversation returns with its history. Nothing here ever types into a busy tab: the
// join/relaunch scripts are gated on the agent having actually exited. All side effects
// are injected; the CLI wires the real osascript/ps/kill versions.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { joinSessionName } from './sessions.mjs';

const AGENT = /^(claude|codex|aider)$/i;

// The relaunch line: the agent's own argv + --continue (once), inside the same caffeinate
// wrapper the user launched it with — dropping caffeinate would silently change whether
// the Mac sleeps mid-session. Only claude-family agents reach this (AGENT gate above).
export function rebuildAgentCommand(argv, processes = []) {
  const cmd = String(argv).trim();
  const withContinue = /(^|\s)--continue(\s|$)/.test(cmd) ? cmd : `${cmd} --continue`;
  return processes.includes('caffeinate') ? `caffeinate ${withContinue}` : withContinue;
}

export async function adoptTab(tty, deps) {
  const { findTab, foregroundArgv, agentPid, shellCwd, kill, doScript, waitForIdle, sleep } = deps;
  const tab = findTab(tty);
  if (!tab) return { ok: false, reason: `no Terminal tab on ${tty}` };

  const name = joinSessionName(shellCwd(tab));
  if (!tab.busy) {
    doScript(tab, `ghost join ${name}`);
    return { ok: true, joined: name };
  }

  const agent = tab.processes.find(p => AGENT.test(p));
  if (!agent) return { ok: false, reason: `${tty} is busy with something that is not a coding agent — ctrl-c it yourself first` };

  const pid = agentPid(tab, agent);
  const argv = foregroundArgv(tab, agent);

  // NEVER interrupt an agent mid-task: connect waits until it is genuinely at its input
  // prompt — two consecutive near-zero CPU samples AND no busy marker in the visible tail
  // ("esc to interrupt" is what claude shows the entire time it works). If it never goes
  // quiet inside the window, decline without touching anything.
  const { agentCpu, tabTail, quietPollMs = 1200, maxQuietWaitMs = 15 * 60_000, onWait } = deps;
  let waited = 0, quiet = false;
  while (waited <= maxQuietWaitMs) {
    const a = agentCpu(pid);
    await sleep(quietPollMs);
    const b = agentCpu(pid);
    const busyScreen = /esc to interrupt|thinking…|working…/i.test(String(tabTail(tab) || ''));
    if (a < 3 && b < 3 && !busyScreen) { quiet = true; break; }
    if (onWait) onWait({ cpu: b, busyScreen });
    await sleep(quietPollMs);
    waited += quietPollMs * 2;
  }
  if (!quiet) return { ok: false, reason: `the ${agent} in ${tty} is still working — connect never interrupts a running task; it will succeed once the agent is idle` };

  // Two INTs, like two Ctrl-Cs — claude's "press ctrl-c again to exit" needs the second.
  kill(pid, 'SIGINT');
  await sleep(350);
  kill(pid, 'SIGINT');
  if (!(await waitForIdle(tab))) return { ok: false, reason: `the ${agent} in ${tty} did not exit — nothing was typed into it` };

  doScript(tab, `ghost join ${name}`);
  await sleep(800);   // the tab is re-entering tmux; give the client a beat before typing
  doScript(tab, rebuildAgentCommand(argv, tab.processes));
  return { ok: true, joined: name, relaunched: agent };
}

// ---------- real deps (Terminal.app + ps) ----------
const osascript = (script) => execFileSync('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();

// Geometry from AppleScript, process chains from ps. Terminal's `processes of t` property
// intermittently dies with a -1700 coercion error under load; `ps -t <tty>` reads the same
// truth from the kernel and never flakes, so AppleScript is only trusted for what nothing
// else can provide: window id, tab index, tty, busy, window name.
const TABS_SCRIPT = `
    set out to ""
    tell application "Terminal"
      repeat with w in windows
        set wid to id of w
        set i to 0
        repeat with t in tabs of w
          set i to i + 1
          -- tab CHARACTER as a "\\t" literal, never the bare word: inside this tell block
          -- that word is Terminal's tab CLASS, and concatenating a class raises -1700
          set out to out & wid & "\\t" & i & "\\t" & (tty of t) & "\\t" & (busy of t) & "\\t" & (name of w) & linefeed
        end repeat
      end repeat
    end tell
    return out`;

export function realOsascriptTabs() { try { return osascript(TABS_SCRIPT); } catch { return ''; } }
export function realPsTty(shortTty) {
  try { return execFileSync('ps', ['-t', shortTty, '-o', 'comm='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
  catch { return ''; }
}

export function listTabs({ osascriptTabs = realOsascriptTabs, psTty = realPsTty } = {}) {
  return osascriptTabs().split('\n').map(l => l.trim()).filter(Boolean).flatMap(line => {
    const f = line.split('\t');
    if (f.length < 5) return [];
    const tty = f[2];
    const processes = psTty(tty.replace(/^\/dev\//, ''))
      .split('\n').map(p => path.basename(p.trim().split(/\s+/)[0] || '')).filter(Boolean);
    if (processes.includes('tmux')) return [];   // already wrapped — in the sessions list or one attach away
    return [{ windowId: Number(f[0]), tabIndex: Number(f[1]), tty, busy: f[3] === 'true', processes, windowName: f[4] }];
  });
}

export function realFindTab(tty) {
  return listTabs().find(t => t.tty === tty) ?? null;
}

// The agent's pid and full argv, via the tab's tty — same fail-closed ps discipline as
// drive.mjs's realForegroundArgv.
export function realAgentPid(tab, agent) {
  const out = execFileSync('ps', ['-t', tab.tty.replace(/^\/dev\//, ''), '-o', 'pid=,comm='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && path.basename(m[2]).toLowerCase() === agent.toLowerCase()) return Number(m[1]);
  }
  return 0;
}
export function realForegroundArgvForAgent(tab, agent) {
  const out = execFileSync('ps', ['-t', tab.tty.replace(/^\/dev\//, ''), '-o', 'comm=,command='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(.*)$/);
    if (m && path.basename(m[1]).toLowerCase() === agent.toLowerCase()) return m[2];
  }
  return agent;
}

// The shell's live cwd on that tty — it names the joined session the way `ghost join`
// itself would (the directory the user is working in).
export function realShellCwd(tab) {
  try {
    const out = execFileSync('ps', ['-t', tab.tty.replace(/^\/dev\//, ''), '-o', 'pid=,comm='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m && /(^|\/)-?(zsh|bash|sh|fish)$/.test(m[2])) {
        const lsof = execFileSync('lsof', ['-a', '-p', m[1], '-d', 'cwd', '-Fn'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const n = lsof.split('\n').find(l => l.startsWith('n'));
        if (n) return n.slice(1);
      }
    }
  } catch { /* fall through */ }
  return '';
}

// The agent's instantaneous CPU — near zero at an input prompt, busy while working.
export function realAgentCpu(pid) {
  try { return parseFloat(execFileSync('ps', ['-p', String(pid), '-o', '%cpu='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()) || 0; }
  catch { return 0; }
}

// The tab's visible tail — claude paints "esc to interrupt" the whole time it works.
export function realTabTail(tab) {
  try {
    const out = osascript(`tell application "Terminal" to get contents of tab ${tab.tabIndex} of window id ${tab.windowId}`);
    return out.split('\n').filter(l => l.trim()).slice(-6).join('\n');
  } catch { return ''; }
}

export function realDoScript(tab, text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  osascript(`tell application "Terminal" to do script "${escaped}" in tab ${tab.tabIndex} of window id ${tab.windowId}`);
}

// Poll until the tab reports not-busy AND its process chain has shrunk back to a shell —
// belt and braces, since do script into a still-running agent would SUBMIT text to it.
export async function realWaitForIdle(tab, { timeoutMs = 10000, pollMs = 300 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const fresh = realFindTab(tab.tty);
    if (fresh && !fresh.busy && !fresh.processes.some(p => AGENT.test(p))) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

export function realAdoptDeps() {
  return {
    findTab: realFindTab,
    foregroundArgv: realForegroundArgvForAgent,
    agentPid: realAgentPid,
    shellCwd: realShellCwd,
    // An agent that exits on the FIRST Ctrl-C makes the second kill hit a dead pid —
    // that's success, not an error.
    kill: (pid, sig) => { try { process.kill(pid, sig); } catch { /* already gone */ } },
    agentCpu: realAgentCpu,
    tabTail: realTabTail,
    onWait: ({ cpu, busyScreen }) => console.log(`  waiting — agent still working (cpu ${cpu.toFixed(0)}%${busyScreen ? ', busy on screen' : ''})…`),
    doScript: realDoScript,
    waitForIdle: realWaitForIdle,
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  };
}
