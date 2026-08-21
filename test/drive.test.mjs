// test/drive.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureTail, isPaneIdle, injectPrompt, driveStep, hauntDrive } from '../src/drive.mjs';

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
