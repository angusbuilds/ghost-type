// test/haunt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { haunt, unhaunt, toggleHaunt, isHaunted, readHaunted } from '../src/haunt.mjs';

function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-haunt-')), 'haunted.json'); }

test('haunt adds a pane and tints it purple', () => {
  const file = tmpFile();
  const tinted = [];
  haunt('%3', { file, tint: (id, c) => tinted.push([id, c]) });
  assert.deepEqual(readHaunted(file), ['%3']);
  assert.equal(tinted[0][0], '%3');
  assert.match(tinted[0][1], /colour/);   // GHOST_PURPLE_256
});

test('unhaunt removes a pane and resets its tint', () => {
  const file = tmpFile();
  const reset = [];
  haunt('%3', { file, tint: () => {} });
  unhaunt('%3', { file, reset: (id) => reset.push(id) });
  assert.deepEqual(readHaunted(file), []);
  assert.deepEqual(reset, ['%3']);
});

test('toggleHaunt flips state', () => {
  const file = tmpFile();
  toggleHaunt('%7', { file, tint: () => {}, reset: () => {} });
  assert.equal(isHaunted('%7', file), true);
  toggleHaunt('%7', { file, tint: () => {}, reset: () => {} });
  assert.equal(isHaunted('%7', file), false);
});

test('haunt does not double-add the same pane', () => {
  const file = tmpFile();
  haunt('%3', { file, tint: () => {} });
  haunt('%3', { file, tint: () => {} });
  assert.deepEqual(readHaunted(file), ['%3']);
});

test('tint failure does not throw (pane may be gone)', () => {
  const file = tmpFile();
  assert.doesNotThrow(() => haunt('%9', { file, tint: () => { throw new Error('no pane'); } }));
  assert.equal(isHaunted('%9', file), true);   // state still recorded
});
