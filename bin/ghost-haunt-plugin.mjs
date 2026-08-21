#!/usr/bin/env node
// SwiftBar plugin — the "upper toolbar" session picker for Ghost Type.
// Shows 👻 in the menu bar; the dropdown lists your live terminal panes (agents first).
// Click a pane to haunt it (turns purple + Ghost Type drives it); click again to release.
//
// Install (once):
//   brew install --cask swiftbar     # then open SwiftBar, pick a plugin folder
//   ln -s ~/dev/ghost-type/bin/ghost-haunt-plugin.mjs "$HOME/Library/Application Support/SwiftBar/Plugins/ghosttype.5s.mjs"
//   (the ".5s." makes SwiftBar refresh every 5 seconds)
import { selectableSessions } from '../src/sessions.mjs';
import { readHaunted } from '../src/haunt.mjs';

// Clicks run through the wrapper so PATH is set (node + tmux resolvable) when SwiftBar fires them.
const WRAPPER = new URL('./ghost-swiftbar.sh', import.meta.url).pathname;

const haunted = new Set(readHaunted());
const panes = selectableSessions();
const activeCount = panes.filter(p => haunted.has(p.paneId)).length;

// menu-bar title
console.log(activeCount ? `👻 ${activeCount}` : '👻');
console.log('---');

if (!panes.length) {
  console.log('no tmux sessions | color=gray');
} else {
  for (const p of panes) {
    const on = haunted.has(p.paneId);
    const dot = on ? '🟣' : '○';
    const label = `${dot} ${p.target}  ${p.cmd}${p.title ? '  — ' + p.title : ''}`.replace(/\|/g, '¦');
    const action = on ? 'unhaunt' : 'haunt';
    const color = on ? 'color=#8b5cf6' : '';
    console.log(`${label} | bash="${WRAPPER}" param0="${action}" param1="${p.paneId}" terminal=false refresh=true ${color}`);
  }
}
console.log('---');
console.log(`Refresh | refresh=true`);
console.log(`Open Ghost Type repo | href=https://github.com/hangryclaude/ghost-type`);
