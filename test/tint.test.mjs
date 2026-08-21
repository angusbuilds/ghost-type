// test/tint.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tintSequence, resetSequence, inTmux, GHOST_PURPLE } from '../src/tint.mjs';

test('tintSequence emits OSC 11 with the given hex', () => {
  const s = tintSequence('#5a2ca0');
  assert.equal(s, '\x1b]11;#5a2ca0\x07');
});

test('tintSequence defaults to ghost purple', () => {
  assert.match(tintSequence(), new RegExp(GHOST_PURPLE));
});

test('tintSequence rejects a bad hex', () => {
  assert.throws(() => tintSequence('purple'), /bad hex/);
  assert.throws(() => tintSequence('#fff'), /bad hex/);
});

test('resetSequence emits OSC 111', () => {
  assert.equal(resetSequence(), '\x1b]111\x07');
});

test('inTmux reflects the TMUX env var', () => {
  assert.equal(inTmux({ TMUX: '/tmp/tmux-501/default,123,0' }), true);
  assert.equal(inTmux({}), false);
});
