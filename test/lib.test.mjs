// test/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byteCap, WORK_DIR, STATE_DIR } from '../src/lib.mjs';

test('byteCap leaves short text untouched', () => {
  assert.equal(byteCap('hello', 100), 'hello');
});

test('byteCap truncates and marks long text', () => {
  const out = byteCap('x'.repeat(50), 20);
  assert.ok(Buffer.byteLength(out) <= 20 + 40); // body + marker
  assert.match(out, /\[truncated/);
});

test('paths live under ~/.ghosttype', () => {
  assert.match(STATE_DIR, /\.ghosttype$/);
  assert.match(WORK_DIR, /\.ghosttype\/work$/);
});
