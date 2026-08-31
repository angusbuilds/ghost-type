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

// The staleness reclaim must be judged against a fixed ceiling, never against the WAITING
// caller's own attempts*waitMs — that let a short-budgeted (or simply slower-polling) waiter
// delete a lock its rightful holder still legitimately held, breaking mutual exclusion for
// any caller that needs it (round-37 audit #3).
test('withFileLock does not reclaim a lock that is still well within staleMs, even when the waiting caller\'s own attempts*waitMs budget is much shorter (round-37 #3)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lock-'));
  const f = path.join(dir, 'state.json');
  const lock = f + '.lock';
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, new Date(Date.now() - 50), new Date(Date.now() - 50));   // 50ms old — plausibly still a live holder
  // waiter's own spin budget (attempts*waitMs = 2*5 = 10ms) is far shorter than the lock's
  // age (50ms) — the old code treated that as proof of abandonment and reclaimed it anyway.
  withFileLock(f, () => {}, { attempts: 2, waitMs: 5 });
  assert.equal(fs.existsSync(lock), true, 'a 50ms-old lock must not be reclaimed just because a short-budgeted waiter gave up sooner');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Even without a premature reclaim, withFileLock's documented "proceed anyway" fallback
// (accepted for haunted.json's best-effort bookkeeping) breaks any caller that needs a real
// guarantee: exhausting attempts still ran fn() unguarded, concurrently with whoever
// actually held the lock. `strict` is the opt-in for callers (claimDrive) that cannot accept
// that — it keeps waiting for the real holder to release instead of proceeding without it.
test('withFileLock in strict mode waits out a still-live holder instead of proceeding without the lock (round-37 #3)', async () => {
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lock-race-'));
  const file = path.join(dir, 'state.json');
  const marker = path.join(dir, 'released');
  const mod = new URL('../src/lib.mjs', import.meta.url).href;

  const holderCode = `import(${JSON.stringify(mod)}).then(async m => {
    const fs = await import('node:fs');
    m.withFileLock(${JSON.stringify(file)}, () => {
      const start = Date.now();
      while (Date.now() - start < 250) { /* busy-hold the lock, simulating a slow critical section */ }
      fs.writeFileSync(${JSON.stringify(marker)}, 'released');
    });
  });`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderCode], { stdio: 'ignore' });
  await new Promise((res) => holder.once('spawn', res));
  await new Promise((res) => setTimeout(res, 50));   // let the holder actually acquire the lock first

  const waiterCode = `import(${JSON.stringify(mod)}).then(async m => {
    const fs = await import('node:fs');
    m.withFileLock(${JSON.stringify(file)}, () => {
      const ranAfterRelease = fs.existsSync(${JSON.stringify(marker)});
      process.stdout.write(ranAfterRelease ? 'ok' : 'RACE');
    }, { attempts: 3, waitMs: 5, strict: true });   // waiter's own budget (~15ms) is far shorter than the holder's 250ms hold
  });`;
  const out = await new Promise((resolve) => {
    const waiter = spawn(process.execPath, ['--input-type=module', '-e', waiterCode], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    waiter.stdout.on('data', (d) => { buf += d; });
    waiter.on('exit', () => resolve(buf));
  });
  assert.equal(out, 'ok', 'strict waiter must not run its critical section before the still-live holder released');
  fs.rmSync(dir, { recursive: true, force: true });
});

// tryAcquire's staleness reclaim previously judged abandonment by file age ALONE — a holder
// that's merely slow (still running fn(), not crashed) looks identical to a crashed one once
// its lock crosses staleMs. Here the holder busy-holds for 300ms while staleMs is set to a
// tiny 50ms, so by the time the waiter starts trying the lock already LOOKS abandoned by age
// — but the holder's pid is still alive, and a live holder must never be stolen from
// regardless of age (round-40 audit #1).
test('withFileLock does not steal a live holder\'s lock even after staleMs has elapsed, because the holder\'s pid is still alive (round-40 audit #1)', async () => {
  const { spawn } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lock-live-'));
  const file = path.join(dir, 'state.json');
  const marker = path.join(dir, 'released');
  const mod = new URL('../src/lib.mjs', import.meta.url).href;

  const holderCode = `import(${JSON.stringify(mod)}).then(async m => {
    const fs = await import('node:fs');
    m.withFileLock(${JSON.stringify(file)}, () => {
      const start = Date.now();
      while (Date.now() - start < 300) { /* busy-hold well past a tiny staleMs, simulating a slow (not crashed) critical section */ }
      fs.writeFileSync(${JSON.stringify(marker)}, 'released');
    }, { staleMs: 50 });
  });`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderCode], { stdio: 'ignore' });
  await new Promise((res) => holder.once('spawn', res));
  await new Promise((res) => setTimeout(res, 100));   // let the holder acquire, and let its lock age well past staleMs=50 while still alive

  const waiterCode = `import(${JSON.stringify(mod)}).then(async m => {
    const fs = await import('node:fs');
    m.withFileLock(${JSON.stringify(file)}, () => {
      const ranAfterRelease = fs.existsSync(${JSON.stringify(marker)});
      process.stdout.write(ranAfterRelease ? 'ok' : 'STOLEN');
    }, { attempts: 3, waitMs: 5, staleMs: 50, strict: true });
  });`;
  const out = await new Promise((resolve) => {
    const waiter = spawn(process.execPath, ['--input-type=module', '-e', waiterCode], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    waiter.stdout.on('data', (d) => { buf += d; });
    waiter.on('exit', () => resolve(buf));
  });
  assert.equal(out, 'ok', 'a strict waiter must not steal an aged-but-still-alive holder\'s lock, and must not run concurrently with it');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Even with the pid-liveness check above, release must independently refuse to delete a lock
// file whose content is no longer the token this process wrote — defense in depth against the
// `finally` block deleting whatever currently sits at the lock path (e.g. a lock reclaimed and
// re-created by someone else) instead of verifying it's still the caller's own (round-40 #1).
test('withFileLock release never deletes a lock file whose content is not the token it wrote (round-40 audit #1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lock-token-'));
  const f = path.join(dir, 'state.json');
  const lock = f + '.lock';
  withFileLock(f, () => {
    // Simulate the lock having been reclaimed and re-created by someone else mid critical
    // section — release must see this isn't its own token and leave it alone.
    fs.writeFileSync(lock, 'someone-else-owns-this-now');
  });
  assert.equal(fs.existsSync(lock), true, 'a lock file that is no longer ours must not be deleted');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'someone-else-owns-this-now', 'release must not touch a lock whose content is not the token it wrote');
  fs.rmSync(dir, { recursive: true, force: true });
});
