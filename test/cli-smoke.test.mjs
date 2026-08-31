// test/cli-smoke.test.mjs — the entry point itself, run as a real subprocess against a FRESH
// HOME (no ~/.ghosttype). Unit tests exercise functions; this catches the first-run failures they
// can't — an import error, an arg-parse crash, or a command that throws on missing state/report/log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GHOST = fileURLToPath(new URL('../bin/ghost.mjs', import.meta.url));

// Run `ghost <args>` with HOME pointed at an empty dir; return { code, out }. execFileSync throws
// on a nonzero exit, so capture the status/stdout+stderr off the thrown error too.
function runGhost(args, home) {
  const opts = { env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  try { return { code: 0, out: execFileSync('node', [GHOST, ...args], opts) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

const CRASH = /at file:\/\/|at Object\.|ReferenceError|TypeError|is not defined|Cannot read prop/;

test('every read-only subcommand runs cleanly on a FRESH install (no ~/.ghosttype)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cli-'));
  try {
    for (const cmd of ['status', 'queue', 'report', 'doctor', 'haunts', 'drives', 'logs', 'sessions', '']) {
      const { code, out } = runGhost(cmd ? [cmd] : [], home);
      assert.doesNotMatch(out, CRASH, `\`ghost ${cmd}\` crashed:\n${out}`);
      assert.equal(code, 0, `\`ghost ${cmd}\` exited ${code}:\n${out}`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an unknown subcommand fails with a clean usage error (exit 2), not a crash', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cli-'));
  try {
    const { code, out } = runGhost(['definitelynotacommand'], home);
    assert.doesNotMatch(out, CRASH, out);
    assert.equal(code, 2);                       // strict flag/command parsing exits 2 (documented)
    assert.match(out, /unknown command/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a command needing an argument reports usage (exit 2) instead of throwing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cli-'));
  try {
    for (const cmd of ['haunt', 'unhaunt', 'drive', 'undrive']) {   // all require a pane id (drive also a goal)
      const { code, out } = runGhost([cmd], home);
      assert.doesNotMatch(out, CRASH, `\`ghost ${cmd}\` crashed:\n${out}`);
      assert.equal(code, 2, `\`ghost ${cmd}\` should be a usage error:\n${out}`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
