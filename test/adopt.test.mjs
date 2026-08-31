// test/adopt.test.mjs — one-click adoption of a live Terminal.app tab: idle tabs get
// `ghost join` scripted into them; a tab running claude gets the exact sequence a human
// would do by hand — Ctrl-C (SIGINT ×2), wait for the shell, join, relaunch the same
// claude command + --continue. Every side effect is injected, so the whole orchestration
// runs offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptTab, rebuildAgentCommand } from '../src/adopt.mjs';

function deps(over = {}) {
  const calls = [];
  return {
    calls,
    d: {
      findTab: (tty) => (tty === '/dev/ttys001'
        ? { windowId: 17494, tabIndex: 1, tty, busy: true, processes: ['login', '-zsh', 'caffeinate', 'claude'] }
        : tty === '/dev/ttys010'
          ? { windowId: 23024, tabIndex: 1, tty, busy: false, processes: ['login', '-zsh'] }
          : null),
      foregroundArgv: () => 'claude --dangerously-skip-permissions',
      agentPid: () => 4242,
      shellCwd: () => '/Users/angus/dev/token-spread',
      kill: (pid, sig) => calls.push(['kill', pid, sig]),
      doScript: (tab, text) => calls.push(['doScript', tab.tty, text]),
      waitForIdle: async () => { calls.push(['waitForIdle']); return true; },
      sleep: async () => {},
      agentCpu: () => 0.4,          // idle at the prompt unless a test says otherwise
      tabTail: () => '❯ ',
      ...over,
    },
  };
}

test('adopting an idle tab just scripts ghost join into it', async () => {
  const { d, calls } = deps();
  const r = await adoptTab('/dev/ttys010', d);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [['doScript', '/dev/ttys010', 'ghost join token-spread']]);
});

test('adopting a busy claude tab: SIGINT ×2, wait, join, relaunch with --continue', async () => {
  const { d, calls } = deps();
  const r = await adoptTab('/dev/ttys001', d);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [
    ['kill', 4242, 'SIGINT'],
    ['kill', 4242, 'SIGINT'],
    ['waitForIdle'],
    ['doScript', '/dev/ttys001', 'ghost join token-spread'],
    ['doScript', '/dev/ttys001', 'caffeinate claude --dangerously-skip-permissions --continue'],
  ]);
});

test('adoption refuses an unknown tty and a busy non-agent tab', async () => {
  const { d } = deps();
  const r = await adoptTab('/dev/ttys099', d);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no Terminal tab/i);

  const { d: d2, calls: c2 } = deps({
    findTab: (tty) => ({ windowId: 1, tabIndex: 1, tty, busy: true, processes: ['login', '-zsh', 'vim'] }),
  });
  const r2 = await adoptTab('/dev/ttys001', d2);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /not a coding agent/i);
  assert.deepEqual(c2, [], 'nothing may be signalled or typed on refusal');
});

test('adoption aborts (no join, no relaunch) if the agent never exits', async () => {
  const fresh = deps({ waitForIdle: async () => false });
  const r = await adoptTab('/dev/ttys001', fresh.d);
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not exit/i);
  assert.deepEqual(fresh.calls.filter(c => c[0] === 'doScript'), [], 'must never type into a tab that is still busy');
});

test('rebuildAgentCommand appends --continue once and preserves the caffeinate wrapper', () => {
  assert.equal(rebuildAgentCommand('claude --dangerously-skip-permissions', ['caffeinate']), 'caffeinate claude --dangerously-skip-permissions --continue');
  assert.equal(rebuildAgentCommand('claude', []), 'claude --continue');
  assert.equal(rebuildAgentCommand('claude --continue', []), 'claude --continue');
  assert.equal(rebuildAgentCommand('node /Users/x/.local/bin/claude --model opus', []), 'node /Users/x/.local/bin/claude --model opus --continue');
});

// Tab listing is AppleScript for geometry (window id / tab index / tty / busy) merged with
// `ps -t` for the process chain — Terminal's `processes of t` property flakes with a -1700
// coercion error under load, and ps never does. Injected runners keep this offline.
test('listTabs merges AppleScript geometry with ps process chains', async () => {
  const { listTabs } = await import('../src/adopt.mjs');
  const asOut = '17494\t1\t/dev/ttys001\ttrue\tangus — token-spread\n23024\t1\t/dev/ttys010\tfalse\tangus — -zsh\n';
  const psByTty = {
    ttys001: 'login -pf angus\n-zsh\ncaffeinate\nclaude --dangerously-skip-permissions\n',
    ttys010: 'login -pf angus\n-zsh\n',
  };
  const tabs = listTabs({
    osascriptTabs: () => asOut,
    psTty: (tty) => psByTty[tty] ?? '',
  });
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs[0], {
    windowId: 17494, tabIndex: 1, tty: '/dev/ttys001', busy: true,
    processes: ['login', '-zsh', 'caffeinate', 'claude'], windowName: 'angus — token-spread',
  });
  assert.deepEqual(tabs[1].processes, ['login', '-zsh']);
});

test('listTabs drops tabs already inside tmux and survives an empty ps read', async () => {
  const { listTabs } = await import('../src/adopt.mjs');
  const asOut = '1\t1\t/dev/ttys008\ttrue\tangus — tmux\n2\t1\t/dev/ttys011\ttrue\tmystery\n';
  const tabs = listTabs({
    osascriptTabs: () => asOut,
    psTty: (tty) => (tty === 'ttys008' ? 'login\n-zsh\ntmux\n' : ''),
  });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].tty, '/dev/ttys011');
  assert.deepEqual(tabs[0].processes, []);
});

// Gentle connect: adoption must never interrupt an agent mid-task. Before the Ctrl-C it
// waits until the agent is genuinely at its input prompt — two consecutive near-zero CPU
// samples AND no busy marker ("esc to interrupt") in the tab's visible tail — and if the
// agent never goes quiet it declines, touching nothing.
function gentleDeps(cpuSeq, tails, over = {}) {
  const calls = [];
  let ci = 0, ti = 0;
  return {
    calls,
    d: {
      findTab: (tty) => ({ windowId: 1, tabIndex: 1, tty, busy: true, processes: ['login', '-zsh', 'caffeinate', 'claude'] }),
      foregroundArgv: () => 'claude',
      agentPid: () => 4242,
      shellCwd: () => '/Users/angus/dev/proj',
      agentCpu: () => cpuSeq[Math.min(ci++, cpuSeq.length - 1)],
      tabTail: () => tails[Math.min(ti++, tails.length - 1)],
      kill: (pid, sig) => calls.push(['kill', pid, sig]),
      doScript: (tab, text) => calls.push(['doScript', text]),
      waitForIdle: async () => true,
      sleep: async () => {},
      maxQuietWaitMs: 10_000,
      ...over,
    },
  };
}

test('adopt waits out a working agent and connects only once it goes quiet', async () => {
  const { d, calls } = gentleDeps([48, 41, 1.2, 0.6], ['⏺ working… esc to interrupt', '❯ ']);
  const r = await adoptTab('/dev/ttys001', d);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls.filter(c => c[0] === 'kill'), [['kill', 4242, 'SIGINT'], ['kill', 4242, 'SIGINT']]);
});

test('adopt declines (nothing signalled, nothing typed) when the agent never goes idle', async () => {
  const { d, calls } = gentleDeps([55, 60, 52, 58, 49, 51], ['⏺ working… esc to interrupt']);
  const r = await adoptTab('/dev/ttys001', d);
  assert.equal(r.ok, false);
  assert.match(r.reason, /still working/i);
  assert.deepEqual(calls, [], 'a busy agent must never be signalled or typed at');
});

test('quiet CPU alone is not enough — a busy screen marker still blocks the connect', async () => {
  const { d, calls } = gentleDeps([0.5, 0.4], ['✳ thinking… (esc to interrupt)']);
  const r = await adoptTab('/dev/ttys001', d);
  assert.equal(r.ok, false);
  assert.deepEqual(calls, []);
});
