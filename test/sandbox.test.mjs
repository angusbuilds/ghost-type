// test/sandbox.test.mjs — the untrusted-repo confinement, exercised against REAL macOS sandbox-exec.
// This is a security boundary (round 8): the coding session may only write inside the clone, and the
// acceptance test gets no network (the exfiltration path). Unit-asserting the profile STRING would
// prove nothing — a typo'd SBPL rule reads fine and fails open — so these run the actual jail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxWriteConfine, sandboxNetDeny } from '../src/sandbox.mjs';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const onMac = process.platform === 'darwin';
const skip = onMac ? false : 'sandbox-exec is macOS-only';
// Run argv; return true if it exited 0, false if the jail (or the command) blocked it.
const runs = (argv) => { try { execFileSync(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; } };

test('sandboxWriteConfine confines writes to the clone — outside the clone is blocked (round 8)', { skip }, () => {
  // Base under /private/tmp, NOT os.tmpdir() (/var/folders) — the profile deliberately allows all of
  // tmpdir for tool state, so an "outside" dir there would be legitimately writable and prove nothing.
  const base = fs.mkdtempSync('/private/tmp/gt-sbroot-');
  const clone = fs.mkdtempSync(path.join(base, 'clone-'));
  const outside = fs.mkdtempSync(path.join(base, 'outside-'));
  try {
    assert.equal(runs(sandboxWriteConfine(['/usr/bin/touch', path.join(clone, 'in.txt')], clone)), true);   // inside → allowed
    assert.ok(fs.existsSync(path.join(clone, 'in.txt')));
    assert.equal(runs(sandboxWriteConfine(['/usr/bin/touch', path.join(outside, 'escape.txt')], clone)), false);   // outside → blocked
    assert.ok(!fs.existsSync(path.join(outside, 'escape.txt')));
    const homeProbe = path.join(os.homedir(), '.ghosttype-sbtest-escape-probe');
    assert.equal(runs(sandboxWriteConfine(['/usr/bin/touch', homeProbe], clone)), false);   // $HOME → blocked
    assert.ok(!fs.existsSync(homeProbe));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('sandboxNetDeny denies network and credential-store writes (round 8)', { skip }, async () => {
  // credential-store write is deterministic (~/.ssh may or may not exist; either way the write fails)
  const sshProbe = path.join(os.homedir(), '.ssh', 'gt-sbtest-escape-probe');
  assert.equal(runs(sandboxNetDeny(['/usr/bin/touch', sshProbe])), false);
  assert.ok(!fs.existsSync(sshProbe));

  // network denial, proven against a local listener so it can't false-pass when offline. The server
  // runs in a SEPARATE process — an in-process one would deadlock, since execFileSync blocks this
  // event loop and the server could never answer the curl. A plain curl to it succeeds; the SAME curl
  // under the jail is blocked.
  const srv = spawn(process.execPath, ['-e',
    "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((res, rej) => { srv.stdout.once('data', d => res(String(d).trim())); srv.once('error', rej); });
    const url = `http://127.0.0.1:${port}/`;
    assert.equal(runs(['/usr/bin/curl', '-s', '--max-time', '5', url]), true, 'the listener must be reachable without the jail');
    assert.equal(runs(sandboxNetDeny(['/usr/bin/curl', '-s', '--max-time', '5', url])), false, 'the jail must block even a localhost connection');
  } finally { srv.kill(); }
});

test('both profiles are a NO-OP off macOS — argv passes through unwrapped', () => {
  const argv = ['echo', 'hi'];
  assert.deepEqual(sandboxWriteConfine(argv, '/some/clone', { platform: 'linux' }), argv);
  assert.deepEqual(sandboxNetDeny(argv, { platform: 'linux' }), argv);
  // and on darwin they DO wrap (prefix sandbox-exec) — the flag is what gates real enforcement
  assert.equal(sandboxWriteConfine(argv, '/c', { platform: 'darwin' })[0], 'sandbox-exec');
  assert.equal(sandboxNetDeny(argv, { platform: 'darwin' })[0], 'sandbox-exec');
});

test('sandboxWriteConfine DENIES the agent binaries + hooks/settings/config, ALLOWS package caches (round 32 parallel-audit CRITICAL)', { skip }, () => {
  // The confined session is for an UNTRUSTED repo. The broad allows (for deps bootstrap) accidentally
  // let it rewrite the tooling that runs the NEXT session — the agent binaries and the hooks/settings/
  // config — a sandbox escape. It must still be able to write package-manager caches.
  const base = fs.mkdtempSync('/private/tmp/gt-sbesc-');
  const home = path.join(base, 'home'), clone = path.join(base, 'clone');
  for (const d of ['.local/bin', '.claude/hooks', '.codex', '.npm', '.cache']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(clone);
  const write = (p) => runs(sandboxWriteConfine(['/usr/bin/touch', p], clone, { home }));
  try {
    // DENIED — the tooling that executes the next session
    assert.equal(write(path.join(home, '.local/bin/claude')), false, 'agent binary must be write-protected');
    assert.equal(write(path.join(home, '.claude/hooks/evil.sh')), false, '~/.claude/hooks (dcg/guard) must be write-protected');
    assert.equal(write(path.join(home, '.claude/settings.json')), false, '~/.claude/settings.json must be write-protected');
    assert.equal(write(path.join(home, '.codex/config.toml')), false, '~/.codex/config.toml must be write-protected');
    // ALLOWED — deps bootstrap must still work
    assert.equal(write(path.join(home, '.npm/x')), true, 'package cache must stay writable');
    assert.equal(write(path.join(home, '.cache/y')), true, 'cache must stay writable');
    assert.equal(write(path.join(clone, 'work.txt')), true, 'the clone must stay writable');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
