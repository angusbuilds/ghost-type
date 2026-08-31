// test/drives.test.mjs
// The drive registry: which panes have a LIVE `ghost drive` process, so the menu bar can
// say "driving" truthfully and stop a drive without ever touching PIDs itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { recordDrive, clearDrive, readDrives, liveDrives, stopDrive, realDriveAlive, claimDrive } from '../src/drives.mjs';

function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-drives-')), 'drives.json'); }

test('recordDrive + readDrives round-trips the entry', () => {
  const file = tmpFile();
  recordDrive('%3', { pid: 4242, goal: 'fix the tests', engine: 'claude' }, { file });
  const d = readDrives(file);
  assert.equal(d['%3'].pid, 4242);
  assert.equal(d['%3'].goal, 'fix the tests');
  assert.equal(d['%3'].engine, 'claude');
  assert.ok(d['%3'].startedAt);
});

test('recordDrive on the same pane overwrites — last drive wins', () => {
  const file = tmpFile();
  recordDrive('%3', { pid: 1, goal: 'old' }, { file });
  recordDrive('%3', { pid: 2, goal: 'new' }, { file });
  assert.equal(readDrives(file)['%3'].pid, 2);
  assert.equal(readDrives(file)['%3'].goal, 'new');
});

test('clearDrive removes the entry', () => {
  const file = tmpFile();
  recordDrive('%3', { pid: 4242, goal: 'g' }, { file });
  clearDrive('%3', { file });
  assert.deepEqual(readDrives(file), {});
});

test('clearDrive with a stale pid leaves a newer drive alone', () => {
  // Drive A dies, drive B starts on the same pane, then A's cleanup runs late —
  // the pid guard stops A from deregistering B.
  const file = tmpFile();
  recordDrive('%3', { pid: 2, goal: 'new' }, { file });
  clearDrive('%3', { file, pid: 1 });
  assert.equal(readDrives(file)['%3'].pid, 2);
  clearDrive('%3', { file, pid: 2 });
  assert.deepEqual(readDrives(file), {});
});

// clearDrive's write must never run before a still-live lock holder (e.g. a concurrent
// claimDrive) releases the lock — its old non-strict withFileLock call let clearDrive give
// up waiting after ~600ms and write from a stale read while another process's critical
// section was still in flight, which can silently erase that process's just-written claim
// (round-38 audit #1). Same cross-process pattern as lib.test.mjs's withFileLock strict-mode
// test, applied to clearDrive directly.
test('clearDrive waits out a still-live lock holder instead of writing unguarded (round-38 #1)', async () => {
  const { spawn: spawnProc } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-drives-lock-race-'));
  const file = path.join(dir, 'drives.json');
  const marker = path.join(dir, 'released');
  fs.writeFileSync(file, JSON.stringify({ '%9': { pid: 1, goal: 'a' } }));
  const libMod = new URL('../src/lib.mjs', import.meta.url).href;
  const drivesMod = new URL('../src/drives.mjs', import.meta.url).href;

  // Holds the REAL lock well past clearDrive's ~600ms non-strict retry budget (40 attempts *
  // 15ms), simulating another process (claimDrive) mid-critical-section, and writes the
  // marker from INSIDE the held lock, before releasing it.
  const holderCode = `import(${JSON.stringify(libMod)}).then(async m => {
    const fs = await import('node:fs');
    m.withFileLock(${JSON.stringify(file)}, () => {
      const start = Date.now();
      while (Date.now() - start < 1800) { /* busy-hold the lock */ }
      fs.writeFileSync(${JSON.stringify(marker)}, 'released');
    });
  });`;
  const holder = spawnProc(process.execPath, ['--input-type=module', '-e', holderCode], { stdio: 'ignore' });
  await new Promise((res) => holder.once('spawn', res));
  await new Promise((res) => setTimeout(res, 50));   // let the holder actually acquire the lock first

  const waiterCode = `import(${JSON.stringify(drivesMod)}).then(async m => {
    const fs = await import('node:fs');
    m.clearDrive('%9', { file: ${JSON.stringify(file)} });
    process.stdout.write(fs.existsSync(${JSON.stringify(marker)}) ? 'ok' : 'RACE');
  });`;
  const out = await new Promise((resolve) => {
    const waiter = spawnProc(process.execPath, ['--input-type=module', '-e', waiterCode], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    waiter.stdout.on('data', (d) => { buf += d; });
    waiter.on('exit', () => resolve(buf));
  });
  assert.equal(out, 'ok', 'clearDrive must not write before the still-live lock holder released');
  fs.rmSync(dir, { recursive: true, force: true });
});

// liveDrives does the same read-prune-conditionally-write cycle as claimDrive/clearDrive on
// the same file, but its withFileLock call used to omit strict mode — so a poll (the menu
// bar hits this every 4s, and `ghost undrive` calls it internally too) racing a slow
// claimDrive could give up waiting after ~600ms and write from a stale read while the claim
// was still mid-critical-section, silently erasing the just-registered claim (round-39 #1;
// same cross-process pattern as clearDrive's round-38 #1 test above, applied to liveDrives).
test('liveDrives waits out a still-live lock holder instead of writing unguarded (round-39 #1)', async () => {
  const { spawn: spawnProc } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-drives-lock-race-'));
  const file = path.join(dir, 'drives.json');
  const marker = path.join(dir, 'released');
  // %9 needs pruning under the lock (its recorded pid isn't alive) so liveDrives' write
  // actually fires — a no-op read never reaches the racy writeJson call at all.
  fs.writeFileSync(file, JSON.stringify({ '%3': { pid: 100 }, '%9': { pid: 99999999 } }));
  const libMod = new URL('../src/lib.mjs', import.meta.url).href;
  const drivesMod = new URL('../src/drives.mjs', import.meta.url).href;

  // Holds the REAL lock well past liveDrives' ~600ms non-strict retry budget (40 attempts *
  // 15ms), simulating claimDrive mid-critical-section (e.g. after committing %3's claim but
  // before releasing the lock), and writes the marker from INSIDE the held lock, before
  // releasing it.
  const holderCode = `import(${JSON.stringify(libMod)}).then(async m => {
    const fs = await import('node:fs');
    m.withFileLock(${JSON.stringify(file)}, () => {
      const start = Date.now();
      while (Date.now() - start < 1800) { /* busy-hold the lock */ }
      fs.writeFileSync(${JSON.stringify(marker)}, 'released');
    });
  });`;
  const holder = spawnProc(process.execPath, ['--input-type=module', '-e', holderCode], { stdio: 'ignore' });
  await new Promise((res) => holder.once('spawn', res));
  await new Promise((res) => setTimeout(res, 50));   // let the holder actually acquire the lock first

  const waiterCode = `import(${JSON.stringify(drivesMod)}).then(async m => {
    const fs = await import('node:fs');
    m.liveDrives({ file: ${JSON.stringify(file)}, isAlive: (e) => e.pid === 100 });
    process.stdout.write(fs.existsSync(${JSON.stringify(marker)}) ? 'ok' : 'RACE');
  });`;
  const out = await new Promise((resolve) => {
    const waiter = spawnProc(process.execPath, ['--input-type=module', '-e', waiterCode], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    waiter.stdout.on('data', (d) => { buf += d; });
    waiter.on('exit', () => resolve(buf));
  });
  assert.equal(out, 'ok', 'liveDrives must not write before the still-live lock holder released');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readDrives is {} on a missing or non-object file', () => {
  const file = tmpFile();
  assert.deepEqual(readDrives(file), {});
  fs.writeFileSync(file, '["not","a","map"]');
  assert.deepEqual(readDrives(file), {});
});

test('liveDrives keeps live entries and prunes dead ones from the file', () => {
  const file = tmpFile();
  recordDrive('%3', { pid: 111, goal: 'a' }, { file });
  recordDrive('%5', { pid: 222, goal: 'b' }, { file });
  const live = liveDrives({ file, isAlive: (e) => e.pid === 222 });
  assert.deepEqual(Object.keys(live), ['%5']);
  // the dead %3 entry is healed out of the registry, not just hidden
  assert.deepEqual(Object.keys(readDrives(file)), ['%5']);
});

test('stopDrive SIGINTs a live drive and reports its pid', () => {
  const file = tmpFile();
  recordDrive('%3', { pid: 4242, goal: 'g' }, { file });
  const killed = [];
  const r = stopDrive('%3', { file, isAlive: () => true, kill: (pid, sig) => killed.push([pid, sig]) });
  assert.deepEqual(r, { stopped: true, pid: 4242 });
  assert.deepEqual(killed, [[4242, 'SIGINT']]);
});

test('stopDrive on a pane with no live drive kills nothing', () => {
  const file = tmpFile();
  recordDrive('%3', { pid: 4242, goal: 'g' }, { file });   // stale — isAlive says dead
  const killed = [];
  const r = stopDrive('%3', { file, isAlive: () => false, kill: (pid, sig) => killed.push([pid, sig]) });
  assert.equal(r.stopped, false);
  assert.deepEqual(killed, []);
  const r2 = stopDrive('%9', { file, isAlive: () => true, kill: (pid, sig) => killed.push([pid, sig]) });
  assert.equal(r2.stopped, false);
  assert.deepEqual(killed, []);
});

// realDriveAlive's paneId check must be a whole-token match, not a bare substring — tmux
// pane ids are unpadded ("%1" is literally contained in "%12", "%100", ...), so a stale
// entry for one pane can wrongly verify "alive" against an unrelated live drive whose pid
// got reused (round-36 audit #13/#18).
test('realDriveAlive does not match a paneId that is only a substring of the real one', async () => {
  const child = spawn('node', ['-e', 'setTimeout(() => {}, 30000)', 'drive', '%12', 'fix-thing'], { stdio: 'ignore' });
  try {
    await new Promise((res) => child.once('spawn', res));
    assert.equal(realDriveAlive({ pid: child.pid, paneId: '%1' }), false, '%1 must not match inside %12');
    assert.equal(realDriveAlive({ pid: child.pid, paneId: '%12' }), true, '%12 itself must still match');
  } finally { child.kill('SIGKILL'); }
});

// realDriveAlive must anchor the paneId check to the argv slot right after the 'drive'
// subcommand token, not scan the whole reconstructed command line — a stale entry's pid can
// be reused by an unrelated `ghost drive <otherPane> "<goal>"` process whose free-text goal
// legitimately contains this paneId as its own standalone token, at the WRONG position
// (round-37 audit #1; round-36 #13/#18 only fixed the bare-SUBSTRING variant).
test('realDriveAlive does not match a paneId that only appears inside the free-text goal', async () => {
  const child = spawn('node', ['-e', 'setTimeout(() => {}, 30000)', 'drive', '%12', 'port', '%3', 'config', 'into', 'the', 'new', 'format'], { stdio: 'ignore' });
  try {
    await new Promise((res) => child.once('spawn', res));
    // %3 is real drive %12's own free-text goal, not what pid is actually driving
    assert.equal(realDriveAlive({ pid: child.pid, paneId: '%3' }), false, '%3 must not match — it only appears inside the goal text, not the drive-target slot');
    assert.equal(realDriveAlive({ pid: child.pid, paneId: '%12' }), true, '%12 (the real drive-target slot) must still match');
  } finally { child.kill('SIGKILL'); }
});

// realDriveAlive must find the pane id after skipping any --engine/--max flag+value pairs
// that precede it, not just the token immediately after 'drive' — `ghost drive --engine
// codex %7 "fix the thing"` is a real, valid invocation (bin/ghost.mjs's parseArgs accepts
// these flags in ANY position relative to the positionals), so a fixed +1 offset reads a
// genuinely live, correctly-driving process as dead (round-38 audit #4).
test('realDriveAlive finds the pane id past --engine/--max flags that precede it', async () => {
  const child = spawn('node', ['-e', 'setTimeout(() => {}, 30000)', 'drive', '--engine', 'codex', '%7', 'fix', 'the', 'thing'], { stdio: 'ignore' });
  try {
    await new Promise((res) => child.once('spawn', res));
    assert.equal(realDriveAlive({ pid: child.pid, paneId: '%7' }), true, '%7 must match even with --engine before it in argv');
  } finally { child.kill('SIGKILL'); }
});

// claimDrive is the atomic replacement for the old check-then-act pair
// (liveDrives()[paneId] read, then a separate recordDrive() write) that let two `ghost
// drive` invocations racing on the same pane both pass the guard before either had
// registered (round-36 audit #5/#9/#14/#17).
test('claimDrive is atomic — a second claim on a still-live pane is rejected, not overwritten', () => {
  const file = tmpFile();
  const first = claimDrive('%3', { pid: 111, goal: 'first' }, { file, isAlive: (e) => e.pid === 111 });
  assert.equal(first.claimed, true);
  const second = claimDrive('%3', { pid: 222, goal: 'second' }, { file, isAlive: (e) => e.pid === 111 });
  assert.equal(second.claimed, false);
  assert.equal(second.existing.pid, 111);
  // the registry still names the FIRST (still-live) drive — never silently overwritten
  assert.equal(readDrives(file)['%3'].pid, 111);
});

test('claimDrive overwrites a stale (dead) entry for the same pane', () => {
  const file = tmpFile();
  claimDrive('%3', { pid: 111, goal: 'dead one' }, { file, isAlive: () => false });
  const claim = claimDrive('%3', { pid: 222, goal: 'new one' }, { file, isAlive: (e) => e.pid === 222 });
  assert.equal(claim.claimed, true);
  assert.equal(readDrives(file)['%3'].pid, 222);
});

// The reject path used to return before writeJson ran, so the file-wide prune claimDrive's
// own comment promises never actually persisted whenever the claim itself was rejected.
test('claimDrive prunes dead entries file-wide even when the claim itself is rejected', () => {
  const file = tmpFile();
  recordDrive('%3', { pid: 111, goal: 'live' }, { file });
  recordDrive('%9', { pid: 999, goal: 'dead elsewhere' }, { file });
  const claim = claimDrive('%3', { pid: 222, goal: 'second' }, { file, isAlive: (e) => e.paneId === '%3' });
  assert.equal(claim.claimed, false);
  // %9 is dead (isAlive is only true for %3) — the reject path must still persist the prune
  assert.deepEqual(Object.keys(readDrives(file)), ['%3']);
});

// Two real, separate processes racing claimDrive on the same pane — the same style of
// cross-process proof test/haunt.test.mjs already uses for withFileLock (round 35), applied
// to claimDrive's atomicity claim instead of same-process sequential calls.
test('claimDrive serializes a cross-process race — exactly one of two concurrent claims on the same pane wins', async () => {
  const file = tmpFile();
  const mod = new URL('../src/drives.mjs', import.meta.url).href;
  const spawnClaim = (pid) => new Promise((resolve) => {
    const code = `import(${JSON.stringify(mod)}).then(m => {
      const r = m.claimDrive('%3', { pid: ${pid}, goal: 'race' }, { file: ${JSON.stringify(file)}, isAlive: () => true });
      process.stdout.write(JSON.stringify(r));
    })`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(JSON.parse(out)));
  });
  const [a, b] = await Promise.all([spawnClaim(111), spawnClaim(222)]);
  const claims = [a, b].filter(r => r.claimed);
  assert.equal(claims.length, 1, `exactly one claim wins: ${JSON.stringify([a, b])}`);
});

test('stopDrive refuses to kill when expectedPid does not match the live drive', () => {
  const file = tmpFile();
  recordDrive('%3', { pid: 4242, goal: 'g' }, { file });
  const killed = [];
  const r = stopDrive('%3', { file, isAlive: () => true, kill: (pid, sig) => killed.push([pid, sig]), expectedPid: 9999 });
  assert.deepEqual(r, { stopped: false, mismatch: true });
  assert.deepEqual(killed, []);
});

test('stopDrive kills when expectedPid matches the live drive', () => {
  const file = tmpFile();
  recordDrive('%3', { pid: 4242, goal: 'g' }, { file });
  const killed = [];
  const r = stopDrive('%3', { file, isAlive: () => true, kill: (pid, sig) => killed.push([pid, sig]), expectedPid: 4242 });
  assert.deepEqual(r, { stopped: true, pid: 4242 });
  assert.deepEqual(killed, [[4242, 'SIGINT']]);
});
