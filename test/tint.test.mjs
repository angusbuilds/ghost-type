// test/tint.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tintSequence, resetSequence, inTmux, GHOST_PURPLE, GHOST_PURPLE_256, tmuxTintPane, tmuxResetPane } from '../src/tint.mjs';

// Is a usable tmux on PATH? The per-pane tint uses `select-pane -P`, whose availability a
// round-28 audit doubted for tmux 3.7b — so we exercise the REAL command, not a mock.
function tmuxAvailable() {
  try { execFileSync('tmux', ['-V'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch { return false; }
}

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

// A round-28 audit claimed `select-pane -P` is invalid on tmux 3.7b, which would leave the
// haunt-mode purple pane silently un-tinted (the same class as the round-27 drive bug). Rather
// than trust the claim, drive REAL tmux: tint a throwaway pane, read its style back, reset it.
// Skipped only when tmux is absent (e.g. minimal CI) — never mocked, or it couldn't catch the
// very breakage it exists to guard against.
test('tmuxTintPane/tmuxResetPane actually set and clear a real pane background', { skip: tmuxAvailable() ? false : 'tmux not on PATH' }, () => {
  const session = `gt-tint-test-${process.pid}`;
  const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf8' });
  try { tmux('kill-session', '-t', session); } catch { /* none to kill */ }
  tmux('new-session', '-d', '-s', session, '-x', '80', '-y', '24');
  try {
    const pane = tmux('list-panes', '-t', session, '-F', '#{pane_id}').trim().split('\n')[0];

    tmuxTintPane(pane, GHOST_PURPLE_256);                          // the exact command haunt() runs
    const styled = tmux('show-options', '-p', '-t', pane).trim();
    assert.match(styled, new RegExp(`window-active-style bg=${GHOST_PURPLE_256}`));   // the tint took effect
    assert.match(styled, new RegExp(`window-style bg=${GHOST_PURPLE_256}`));

    tmuxResetPane(pane);                                           // the exact command unhaunt() runs
    const cleared = tmux('show-options', '-p', '-t', pane).trim();
    assert.doesNotMatch(cleared, /window-active-style bg=colour55/);   // tint gone again
  } finally {
    try { tmux('kill-session', '-t', session); } catch { /* best effort */ }
  }
});
