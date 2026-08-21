// test/sessions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePanes, isAgentSession, listSessions, selectableSessions } from '../src/sessions.mjs';

const SAMPLE = [
  '%3\tmain\t0.0\tclaude\tclaude\tghost-type — claude',
  '%4\tmain\t1.0\tzsh\tzsh\t~/dev',
  '%7\twork\t0.1\tcodex\tcodex\tcodex exec',
  '%9\tmisc\t0.0\ttop\ttop\t',
].join('\n');

test('parsePanes structures each pane with a tmux target + window name', () => {
  const panes = parsePanes(SAMPLE);
  assert.equal(panes.length, 4);
  assert.equal(panes[0].paneId, '%3');
  assert.equal(panes[0].target, 'main:0.0');
  assert.equal(panes[0].windowName, 'claude');
  assert.equal(panes[2].cmd, 'codex');
});

test('isAgentSession flags claude/codex panes, not top', () => {
  const panes = parsePanes(SAMPLE);
  assert.equal(isAgentSession(panes[0]), true);   // claude
  assert.equal(isAgentSession(panes[2]), true);   // codex
  assert.equal(isAgentSession(panes[3]), false);  // top
});

test('selectableSessions puts agent-ish panes first', () => {
  const list = selectableSessions({ tmux: () => SAMPLE });
  assert.equal(list[0].cmd, 'claude');
  assert.ok(['claude', 'codex'].includes(list[1].cmd));
});

test('listSessions returns [] when tmux is unavailable', () => {
  assert.deepEqual(listSessions({ tmux: () => { throw new Error('no tmux'); } }), []);
});
