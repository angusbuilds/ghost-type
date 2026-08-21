// test/clone.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeClone, validateClonePath } from '../src/clone.mjs';
import { WORK_DIR } from '../src/lib.mjs';

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-src-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir });
  g('init', '-q');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  g('add', '-A'); g('commit', '-q', '-m', 'init');
  return dir;
}

test('validateClonePath rejects paths outside WORK_DIR', () => {
  assert.throws(() => validateClonePath('/etc/passwd'), /outside/);
  assert.doesNotThrow(() => validateClonePath(path.join(WORK_DIR, 'x')));
});

test('makeClone produces an isolated clone with no origin remote', () => {
  const src = tmpRepo();
  const clone = makeClone(src, 'test-' + process.pid);
  assert.ok(fs.existsSync(path.join(clone, 'a.txt')));
  const remotes = execFileSync('git', ['remote'], { cwd: clone }).toString().trim();
  assert.equal(remotes, ''); // origin removed → push impossible
  fs.rmSync(clone, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});
