// test/run.test.mjs — `ghost run`: driving with NO existing terminal. Ghost Type creates
// its own detached tmux session in the project dir, boots the agent inside it, waits until
// the pane's foreground really is the agent, then hands the pane to a detached drive.
// Everything is injected; the orchestration runs offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInBackground } from '../src/run.mjs';

function deps(over = {}) {
  const calls = [];
  return {
    calls,
    d: {
      sessionExists: () => false,
      tmuxNewSession: (name, dir) => { calls.push(['new', name, dir]); return '%9'; },
      typeIntoPane: (paneId, line) => calls.push(['type', paneId, line]),
      waitForAgent: async (paneId) => { calls.push(['waitAgent', paneId]); return true; },
      spawnDrive: (paneId, goal, engine) => calls.push(['drive', paneId, goal, engine]),
      sleep: async () => {},
      ...over,
    },
  };
}

test('run creates a detached session in the project dir, boots the agent, then drives', async () => {
  const { d, calls } = deps();
  const r = await runInBackground({ dir: '/Users/x/dev/gallery', goal: 'make it lazy load', engine: 'claude', agentCommand: 'claude' }, d);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.session, 'gallery');
  assert.deepEqual(calls, [
    ['new', 'gallery', '/Users/x/dev/gallery'],
    ['type', '%9', 'claude'],
    ['waitAgent', '%9'],
    ['drive', '%9', 'make it lazy load', 'claude'],
  ]);
});

test('run uniquifies the session name instead of colliding', async () => {
  const { d, calls } = deps({ sessionExists: (n) => n === 'gallery' });
  const r = await runInBackground({ dir: '/Users/x/dev/gallery', goal: 'g', engine: 'claude', agentCommand: 'claude' }, d);
  assert.equal(r.session, 'gallery-2');
  assert.equal(calls[0][1], 'gallery-2');
});

test('run refuses to drive if the agent never appears — and kills its orphan session', async () => {
  const { d, calls } = deps({ waitForAgent: async () => false, killSession: (n) => calls.push(['killSession', n]) });
  const r = await runInBackground({ dir: '/Users/x/dev/gallery', goal: 'g', engine: 'claude', agentCommand: 'claude' }, d);
  assert.equal(r.ok, false);
  assert.match(r.reason, /never became ready/i);
  assert.ok(!calls.some(c => c[0] === 'drive'), 'no drive may attach to a pane without a verified agent');
  assert.deepEqual(calls.at(-1), ['killSession', 'gallery'], 'the half-born session must not linger');
});

test('run rejects an empty goal before touching tmux', async () => {
  const { d, calls } = deps();
  const r = await runInBackground({ dir: '/x', goal: '   ', engine: 'claude', agentCommand: 'claude' }, d);
  assert.equal(r.ok, false);
  assert.deepEqual(calls, []);
});
