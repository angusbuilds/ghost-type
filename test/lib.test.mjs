// test/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byteCap, WORK_DIR, STATE_DIR, readJson, writeJson, engineFailed, withFileLock } from '../src/lib.mjs';
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

test('engineFailed flags every failure shape but not a clean success (round 32 parallel-audit HIGH)', () => {
  // clean success → NOT failed
  assert.equal(engineFailed({ exitCode: 0, result: { subtype: 'success', is_error: false } }), false);
  assert.equal(engineFailed({ exitCode: 0, result: null, text: 'ok' }), false);   // no result event (bare text) is fine
  // failures → flagged
  assert.equal(engineFailed({ exitCode: 1, result: null }), true);                              // transport/crash
  assert.equal(engineFailed({ exitCode: 0, result: { subtype: 'success', is_error: true } }), true);  // Claude limit shape (round 28)
  assert.equal(engineFailed({ exitCode: 0, result: { subtype: 'error', result: 'usage limit reached' } }), true);   // fake-claude rate-limit shape: subtype!=='success', no is_error
  assert.equal(engineFailed({ exitCode: 0, result: { subtype: 'error_max_turns' } }), true);    // Claude error subtypes
  assert.equal(engineFailed(null), false);
});

test('withFileLock runs fn while holding the lock, returns its value, and releases the lock (round 35)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lock-'));
  const f = path.join(dir, 'state.json');
  const r = withFileLock(f, () => { assert.equal(fs.existsSync(f + '.lock'), true, 'lock held during fn'); return 42; });
  assert.equal(r, 42);
  assert.equal(fs.existsSync(f + '.lock'), false, 'lock released after fn');
  // a stale lock (older than the spin budget) is reclaimed rather than blocking forever
  fs.writeFileSync(f + '.lock', ''); fs.utimesSync(f + '.lock', new Date(0), new Date(0));   // ancient mtime
  assert.equal(withFileLock(f, () => 7, { attempts: 3, waitMs: 5 }), 7);
  fs.rmSync(dir, { recursive: true, force: true });
});
