// src/sessions.mjs
// Enumerate the terminal sessions the owner can hand to Ghost Type (haunt mode). Backed by
// tmux today (list every pane across sessions); the menu-bar picker reads this list, and a
// chosen pane is the target for the purple tint + prompt injection. tmux runner is injected
// so this is testable offline.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const FMT = '#{pane_id}\t#{session_name}\t#{window_index}.#{pane_index}\t#{pane_current_command}\t#{window_name}\t#{pane_title}';

function realTmux(...args) {
  return execFileSync('tmux', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

// Parse `tmux list-panes -a -F <FMT>` output into structured sessions.
export function parsePanes(text) {
  return String(text).split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [paneId, session, loc, cmd, windowName, ...titleParts] = line.split('\t');
    return { paneId, session, loc, cmd, windowName: windowName || '', title: titleParts.join('\t') || '', target: `${session}:${loc}` };
  });
}

// A short human name for the pane, for the menu-bar label. Prefer a custom window name,
// else the running command, else the tmux target.
export function paneName(p) {
  const w = (p.windowName || '').trim();
  if (w && w !== p.cmd && !/^\d/.test(w)) return w;   // a real, named window
  if (p.cmd && p.cmd !== 'zsh' && p.cmd !== 'bash') return p.cmd;
  return p.target;
}

// True when a pane is actually running a coding agent Ghost Type can drive — the panes
// worth surfacing first. Plain shells are still selectable, just not prioritized.
const AGENTISH = /\b(claude|codex|aider|opencode)\b/i;
export function isAgentSession(p) { return AGENTISH.test(p.cmd) || AGENTISH.test(p.title); }

export function listSessions({ tmux = realTmux } = {}) {
  let out = '';
  try { out = tmux('list-panes', '-a', '-F', FMT); } catch { return []; }
  return parsePanes(out);
}

// The panes most likely to be an agent the owner wants driven, agent-ish first.
export function selectableSessions(opts = {}) {
  const all = listSessions(opts);
  return [...all.filter(isAgentSession), ...all.filter(p => !isAgentSession(p))];
}

// `ghost join` session naming: the project directory IS the name (that's how Angus thinks
// of his terminals), sanitized to tmux's rules — ':' and '.' are target separators and must
// never appear in a session name. Falls back to 'ghost' when the cwd gives nothing usable.
export function joinSessionName(cwd) {
  const base = path.basename(String(cwd || ''));
  const safe = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'ghost';
}
