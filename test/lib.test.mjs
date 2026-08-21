// test/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byteCap, WORK_DIR, STATE_DIR, readJson, writeJson } from '../src/lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('writeJson is atomic (leaves no .tmp behind) and round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lib-'));
  const f = path.join(dir, 'state.json');
  writeJson(f, { a: 1, q: ['x'] });
  assert.deepEqual(readJson(f, null), { a: 1, q: ['x'] });
  assert.equal(fs.readdirSync(dir).filter(n => n.includes('.tmp')).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJson leaves NO temp behind when serialization fails mid-write (round 4 #13)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lib-'));
  const f = path.join(dir, 'state.json');
  const circular = {}; circular.self = circular;               // JSON.stringify throws on this
  assert.throws(() => writeJson(f, circular));
  assert.equal(fs.readdirSync(dir).filter(n => n.includes('.tmp')).length, 0, 'temp cleaned up on failure');
  assert.equal(fs.existsSync(f), false, 'no partial destination file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJson preserves a corrupt file instead of silently discarding it (M1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lib-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, '{"queue": [trunc');   // crash-truncated JSON
  assert.deepEqual(readJson(f, { fallback: true }), { fallback: true });
  assert.ok(fs.readdirSync(dir).some(n => n.startsWith('state.json.corrupt-')), 'corrupt copy preserved');
  fs.rmSync(dir, { recursive: true, force: true });
});

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
