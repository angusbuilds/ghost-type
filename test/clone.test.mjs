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

test('clone objects do NOT share inodes with the source (no-hardlinks isolation)', () => {
  const src = tmpRepo();
  const clone = makeClone(src, 'inode-' + process.pid);
  const objDir = (root) => path.join(root, '.git', 'objects', 'pack');
  const packOf = (root) => { try { return fs.readdirSync(objDir(root)).filter(f => f.endsWith('.pack'))[0]; } catch { return null; } };
  // loose objects: compare inode of one shared object path if it exists in both
  const srcObjs = path.join(src, '.git', 'objects');
  function firstLoose(root) {
    const base = path.join(root, '.git', 'objects');
    for (const d of fs.readdirSync(base)) {
      if (d.length === 2) {
        const sub = path.join(base, d);
        const files = fs.readdirSync(sub);
        if (files.length) return path.join(sub, files[0]).replace(base, '');
      }
    }
    return null;
  }
  const rel = firstLoose(src);
  if (rel) {
    const sIno = fs.statSync(path.join(src, '.git', 'objects', rel)).ino;
    const cPath = path.join(clone, '.git', 'objects', rel);
    if (fs.existsSync(cPath)) {
      assert.notEqual(fs.statSync(cPath).ino, sIno, 'clone object must be a separate inode');
    }
  }
  fs.rmSync(clone, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});
