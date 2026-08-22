// test/drive.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureTail, isPaneIdle, injectPrompt, driveStep, hauntDrive, sanitizeInjection } from '../src/drive.mjs';

test('sanitizeInjection keeps a clean line, rejects control chars/newlines/empty', () => {
  assert.equal(sanitizeInjection('fix the failing parser test'), 'fix the failing parser test');
  assert.equal(sanitizeInjection('do this\nrm -rf /'), 'do this');       // only the first line survives
  assert.equal(sanitizeInjection('tab\there\tnow'), 'tabherenow');       // control chars (tab) stripped
  assert.equal(sanitizeInjection('   '), null);
  assert.equal(sanitizeInjection('x'.repeat(700)), null);                 // over the ceiling
});

test('driveStep rejects unsafe generated text instead of typing it', async () => {
  const sent = [];
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'agent output here', deps: {
    runner: (...a) => a[0] === 'list-panes' ? '%3' : a[0] === 'display-message' ? 'claude' : 'agent output here',
    sendKeys: (id, k) => sent.push(k), humanIdleSecs: () => 999,
    engine: async () => ({ text: '   ' }),   // empty → unsafe
    voice: { profile: '', bank: {} }, sleep: async () => {},
  }});
  assert.equal(r.state, 'rejected');
  assert.deepEqual(sent, []);                                             // nothing typed
});

test('driveStep refuses to type when the pane dropped to a bare shell (agent exited)', async () => {
  const sent = [];
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'agent output here', deps: {
    runner: (...a) => {
      if (a[0] === 'list-panes') return '%3';
      if (a[0] === 'display-message') return 'zsh';   // foreground is a shell, not the agent
      return 'agent output here';
    },
    sendKeys: (id, k) => sent.push(k), humanIdleSecs: () => 999,
    engine: async () => ({ text: 'do the next thing' }),
    voice: { profile: '', bank: {} }, sleep: async () => {},
  }});
  assert.equal(r.state, 'shell');
  assert.deepEqual(sent, []);   // nothing typed into the shell
});

test('driveStep pauses if the human becomes active DURING generation (fresh recheck)', async () => {
  let idleCall = 0;
  const sent = [];
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'agent output here', deps: {
    runner: (...a) => a[0] === 'list-panes' ? '%3' : a[0] === 'display-message' ? 'claude' : 'agent output here',
    sendKeys: (id, k) => sent.push(k),
    humanIdleSecs: () => (++idleCall === 1 ? 999 : 3),   // away, then at the keyboard
    engine: async () => ({ text: 'do the next thing' }),
    voice: { profile: '', bank: {} }, sleep: async () => {},
  }});
  assert.equal(r.state, 'paused');
  assert.deepEqual(sent, []);
});

test('captureTail keeps the last non-empty lines', () => {
  assert.equal(captureTail('a\n\nb\n\n\nc\n', 2), 'b\nc');
});

test('isPaneIdle is true only when output is stable and non-empty', () => {
  assert.equal(isPaneIdle('x', 'x'), true);
  assert.equal(isPaneIdle('x', 'y'), false);
  assert.equal(isPaneIdle('', ''), false);
});

test('injectPrompt is two-step: text THEN Enter, never a blind Enter', async () => {
  const calls = [];
  await injectPrompt('%3', 'keep going', { sendKeys: (id, k) => calls.push([id, k]), sleep: async () => {} });
  assert.deepEqual(calls, [['%3', 'keep going'], ['%3', 'Enter']]);
});

function deps(over = {}) {
  return {
    runner: (...a) => a[0] === 'list-panes' ? '%3\n%4' : a[0] === 'display-message' ? 'claude' : 'agent output here',
    sendKeys: () => {},
    humanIdleSecs: () => 999,            // human away
    engine: async () => ({ text: 'do the next thing' }),
    voice: { profile: 'terse', bank: {} },
    sleep: async () => {},
    ...over,
  };
}

test('driveStep pauses when the human is active (never types over you)', async () => {
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'x', deps: deps({ humanIdleSecs: () => 5 }) });
  assert.equal(r.state, 'paused');
});

test('driveStep reports gone when the pane vanished', async () => {
  const r = await driveStep({ paneId: '%99', goal: 'g', prev: 'x', deps: deps() });
  assert.equal(r.state, 'gone');
});

test('driveStep injects a voiced prompt when the pane goes idle', async () => {
  const sent = [];
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'agent output here', deps: deps({ sendKeys: (id, k) => sent.push(k) }) });
  assert.equal(r.state, 'injected');
  assert.match(r.prompt, /do the next thing/);
  assert.deepEqual(sent, ['do the next thing', 'Enter']);   // two-step
});

test('driveStep stays hands-off while the agent is still producing output', async () => {
  let n = 0;
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'old output', deps: deps({ runner: (...a) => a[0] === 'list-panes' ? '%3' : a[0] === 'display-message' ? 'claude' : 'new output ' + (n++) }) });
  assert.equal(r.state, 'working');
});

test('driveStep fails CLOSED on an unknown foreground probe: never types, keeps polling', async () => {
  // An empty probe means the tmux read itself failed (transient) — NOT that the agent exited.
  // Fail-closed on typing (send nothing) but keep polling rather than terminating the drive on
  // a blip; a genuinely dead pane is caught by paneAlive separately (round 4 #3/#5).
  const sent = [];
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'out', deps: {
    runner: (...a) => a[0] === 'list-panes' ? '%3' : a[0] === 'display-message' ? '' : 'out',
    sendKeys: (i, k) => sent.push(k), humanIdleSecs: () => 999, engine: async () => ({ text: 'go' }),
    voice: { profile: '', bank: {} }, sleep: async () => {},
  }});
  assert.equal(r.state, 'working');     // unknown foreground → not confirmably an agent → no inject, keep polling
  assert.deepEqual(sent, []);
});

test('foregroundIsAgent: a generic runtime is an agent ONLY if its argv names one (round 4 #3)', async () => {
  const { foregroundIsAgent } = await import('../src/drive.mjs');
  const runner = (cmd) => (...a) => a[0] === 'display-message' && a.includes('#{pane_current_command}') ? cmd
    : a[0] === 'display-message' ? '/dev/ttys001' : '';
  // bare `node` running a build → NOT an agent (argv has no agent)
  assert.equal(foregroundIsAgent('%1', { runner: runner('node'), ps: () => 'node /repo/build.js' }), false);
  // `node` actually running claude → IS an agent
  assert.equal(foregroundIsAgent('%1', { runner: runner('node'), ps: () => 'node /Users/x/.local/bin/claude' }), true);
  // direct claude needs no argv probe
  assert.equal(foregroundIsAgent('%1', { runner: runner('claude'), ps: () => '' }), true);
  // a plain shell is never an agent
  assert.equal(foregroundIsAgent('%1', { runner: runner('zsh'), ps: () => '-zsh' }), false);
});

test('injectPrompt skips Enter when beforeEnter fails after the pause (round 4 #3)', async () => {
  const calls = [];
  const sent = await injectPrompt('%3', 'keep going', { sendKeys: (id, k) => calls.push(k), sleep: async () => {}, beforeEnter: () => false });
  assert.equal(sent, false);
  assert.deepEqual(calls, ['keep going']);   // text was typed, but Enter was NOT sent into a changed world
});

test('driveStep still sends Enter when the TUI ECHOES the typed prompt (pane changes after typing) (round 27)', async () => {
  const sent = [];
  let typed = false;
  const r = await driveStep({ paneId: '%3', goal: 'keep fixing the parser', prev: 'agent output here', deps: {
    runner: (...a) => {
      if (a[0] === 'list-panes') return '%3';
      if (a[0] === 'display-message') return 'claude';                              // a live agent throughout
      return typed ? 'agent output here\n> keep fixing the parser' : 'agent output here';   // pane ECHOES after typing
    },
    sendKeys: (id, k) => { sent.push(k); if (k !== 'Enter' && k !== 'C-u') typed = true; },
    humanIdleSecs: () => 999,
    engine: async () => ({ text: 'keep fixing the parser' }),
    voice: { profile: '', bank: {} }, sleep: async () => {},
  }});
  assert.equal(r.state, 'injected');                     // NOT 'aborted' — our own echo must not block Enter
  assert.ok(sent.includes('Enter'), 'Enter was sent despite the pane changing from the echo');
  assert.ok(!sent.includes('C-u'), 'no Ctrl-U — this was a live agent, not a shell exit');
});

test('driveStep clears stranded text with Ctrl-U when the agent exits to a shell mid-delay (round 5 H3)', async () => {
  // agent recognized on the first pass; by the time beforeEnter runs, the pane is a bare shell.
  let cmdCall = 0;
  const sent = [];
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'agent output here', deps: {
    runner: (...a) => {
      if (a[0] === 'list-panes') return '%3';
      if (a[0] === 'display-message') return (++cmdCall <= 4) ? 'claude' : 'zsh';   // agent through recheck, shell in beforeEnter
      return 'agent output here';
    },
    sendKeys: (id, k) => sent.push(k), humanIdleSecs: () => 999,
    engine: async () => ({ text: 'do the next thing' }),
    voice: { profile: '', bank: {} }, sleep: async () => {},
  }});
  assert.equal(r.state, 'aborted');
  assert.ok(!sent.includes('Enter'), 'never pressed Enter into the shell');
  assert.ok(sent.includes('C-u'), 'cleared the stranded line');
});

test('a failed writer call in haunt mode never injects the error text (round 7 Medium#1)', async () => {
  const sent = [];
  const r = await driveStep({ paneId: '%3', goal: 'keep fixing the parser', prev: 'agent output here', deps: {
    runner: (...a) => a[0] === 'list-panes' ? '%3' : a[0] === 'display-message' ? 'claude' : 'agent output here',
    sendKeys: (id, k) => sent.push(k), humanIdleSecs: () => 999,
    // writer returns a FULL result with a nonzero exit + error text (as the real drive engine now does)
    engine: async () => ({ exitCode: 1, result: null, text: 'network unreachable after retries' }),
    voice: { profile: '', bank: {} }, sleep: async () => {},
  }});
  assert.equal(r.state, 'injected');
  assert.doesNotMatch(r.prompt, /network unreachable/);   // the transport error is never injected
  assert.match(r.prompt, /parser/);                       // falls back to the goal instead
});

test('a Claude RATE-LIMIT (exit 0, is_error:true) in haunt mode also falls back to the goal, never injects the limit text (round 28/29)', async () => {
  // The insidious shape: Claude reports a usage limit as subtype:success + is_error:true with
  // exit 0 — an exit-code-only guard would treat it as a real prompt and type the limit banner
  // straight into the owner's live pane. engineFailed() catches it via result.is_error; this
  // pins that at the drive boundary so a narrowed guard can't silently regress the live path.
  const sent = [];
  const r = await driveStep({ paneId: '%3', goal: 'keep fixing the parser', prev: 'agent output here', deps: {
    runner: (...a) => a[0] === 'list-panes' ? '%3' : a[0] === 'display-message' ? 'claude' : 'agent output here',
    sendKeys: (id, k) => sent.push(k), humanIdleSecs: () => 999,
    engine: async () => ({ exitCode: 0, result: { subtype: 'success', is_error: true }, text: 'Claude usage limit reached. Your limit will reset at 6pm.' }),
    voice: { profile: '', bank: {} }, sleep: async () => {},
  }});
  assert.equal(r.state, 'injected');
  assert.doesNotMatch(r.prompt, /usage limit|reset at/i);   // the limit banner is never injected
  assert.match(r.prompt, /parser/);                         // falls back to the goal instead
});

test('driveStep keeps polling (does not terminate) while a subprocess/tool runs (round 4 #5)', async () => {
  // foreground is `git` (a tool the agent spawned) — neither shell nor agent → 'working', never 'shell'.
  const sent = [];
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'out', deps: {
    runner: (...a) => a[0] === 'list-panes' ? '%3' : a[0] === 'display-message' ? 'git' : 'out',
    sendKeys: (i, k) => sent.push(k), humanIdleSecs: () => 999, engine: async () => ({ text: 'go' }),
    voice: { profile: '', bank: {} }, sleep: async () => {},
  }});
  assert.equal(r.state, 'working');
  assert.deepEqual(sent, []);
});

test('hauntDrive stops (agent-exited) when a stable pane is a bare shell', async () => {
  let sent = 0;
  const d = deps({
    runner: (...a) => a[0] === 'list-panes' ? '%3' : a[0] === 'display-message' ? 'zsh' : 'stable output',
    engine: async () => ({ text: 'x' }), sendKeys: () => { sent++; },
  });
  const out = await hauntDrive({ paneId: '%3', goal: 'g', deps: d, pollMs: 0, minStable: 2 });
  assert.equal(out.reason, 'agent-exited');   // terminal — doesn't spend forever
  assert.equal(out.injects, 0);
  assert.equal(sent, 0);
});

test('hauntDrive stops when the pane dies', async () => {
  let polls = 0;
  const d = deps({ runner: (...a) => { if (a[0] === 'list-panes') return (polls++ < 1) ? '%3' : ''; return 'x'; } });
  const out = await hauntDrive({ paneId: '%3', goal: 'g', deps: d, pollMs: 0 });
  assert.equal(out.reason, 'pane-gone');
});

test('hauntDrive waits for minStable identical polls before injecting (H2)', async () => {
  let sent = 0, listCalls = 0, n = 0;
  // pane output changes every poll → never stable → must never inject; pane dies after 5 polls
  const d = deps({
    runner: (...a) => {
      if (a[0] === 'list-panes') return (listCalls++ < 5) ? '%3' : '';   // gone after 5 polls
      return 'moving ' + (n++);                                          // output never repeats
    },
    sendKeys: () => { sent++; },
  });
  const out = await hauntDrive({ paneId: '%3', goal: 'g', deps: d, pollMs: 0, minStable: 3 });
  assert.equal(out.reason, 'pane-gone');
  assert.equal(out.injects, 0);   // never stable → never injected
  assert.equal(sent, 0);
});
