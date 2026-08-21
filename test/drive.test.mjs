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
    runner: (...a) => a[0] === 'list-panes' ? '%3' : 'agent output here',
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
    runner: (...a) => a[0] === 'list-panes' ? '%3' : 'agent output here',
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
    runner: (...a) => a[0] === 'list-panes' ? '%3\n%4' : 'agent output here',
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
  const r = await driveStep({ paneId: '%3', goal: 'g', prev: 'old output', deps: deps({ runner: (...a) => a[0] === 'list-panes' ? '%3' : 'new output ' + (n++) }) });
  assert.equal(r.state, 'working');
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
