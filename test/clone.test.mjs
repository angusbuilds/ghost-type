// test/clone.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeClone, validateClonePath, assertNoSymlinkAncestor, commitTreeRef, fetchBranchBack } from '../src/clone.mjs';
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

test('makeClone refuses a source that overlaps the work dir (H8)', () => {
  assert.throws(() => makeClone(path.join(WORK_DIR, 'some-repo'), 'x'), /overlaps/);
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

test('makeClone QUARANTINES an existing same-name clone instead of deleting it (round 6 #4)', () => {
  const src = tmpRepo();
  const taskId = 'quar-' + process.pid;
  const clone = makeClone(src, taskId);
  // simulate crashed, unbranched work left in the clone from a prior run
  fs.writeFileSync(path.join(clone, 'CRASHED_WORK.txt'), 'unsaved progress');
  // a same-night restart regenerates the same taskId → must NOT destroy that work
  makeClone(src, taskId);
  const parent = path.dirname(clone);
  const quarantined = fs.readdirSync(parent).find(n => n.startsWith(`${taskId}.crashed-`));
  assert.ok(quarantined, 'the prior clone was quarantined, not deleted');
  assert.ok(fs.existsSync(path.join(parent, quarantined, 'CRASHED_WORK.txt')), 'crashed work preserved');
  fs.rmSync(clone, { recursive: true, force: true });
  fs.rmSync(path.join(parent, quarantined), { recursive: true, force: true });
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

test('assertNoSymlinkAncestor refuses a symlinked ancestor within the guarded root (round 5 L1)', () => {
  // realpath so stopAt matches (macOS /var → /private/var); the guard stops at this root and
  // deliberately ignores OS-level symlinks above it.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-anc-')));
  const real = path.join(base, 'real'); fs.mkdirSync(real);
  const link = path.join(base, 'link'); fs.symlinkSync(real, link);
  const throughLink = path.join(link, 'a'); fs.mkdirSync(throughLink, { recursive: true });
  assert.throws(() => assertNoSymlinkAncestor(throughLink, base), /symlinked path component/);
  assert.doesNotThrow(() => assertNoSymlinkAncestor(path.join(real, 'x'), base));   // all-real path is fine
  fs.rmSync(base, { recursive: true, force: true });
});

test('commitTreeRef ships the EXACT tree with NO hooks run — a post-checkout hook cannot mutate it (round 13)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ct-'));
  const g = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();
  g(d, 'init', '-q'); g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'FEATURE.txt'), 'ok');
  g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'base');
  const base = g(d, 'rev-parse', 'HEAD').trim();
  // the candidate: modify FEATURE.txt, freeze it as a tree
  fs.writeFileSync(path.join(d, 'FEATURE.txt'), 'the verified content');
  g(d, 'add', '-A'); const tree = g(d, 'write-tree').trim();
  // plant a malicious executable post-checkout hook that would corrupt FEATURE.txt on checkout
  fs.writeFileSync(path.join(d, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nprintf HACKED >> FEATURE.txt\n');
  fs.chmodSync(path.join(d, '.git', 'hooks', 'post-checkout'), 0o755);
  // ship via commit-tree/update-ref (no checkout) — the hook must never run
  commitTreeRef(g, d, 'ghost/x', tree, base, 'ghost: ship');
  const shipped = g(d, 'show', 'ghost/x:FEATURE.txt');
  assert.equal(shipped, 'the verified content');                 // exactly the verified tree...
  assert.equal(g(d, 'rev-parse', 'ghost/x^{tree}').trim(), tree); // ...bound to the branch commit
  fs.rmSync(d, { recursive: true, force: true });
});

test('fetchBranchBack is OID-pinned — a repointed clone branch cannot change what lands in source (round 15)', () => {
  const src = tmpRepo();
  const clone = makeClone(src, 'ft-' + process.pid);
  const g = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();
  const base = g(clone, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(clone, 'feature.js'), 'verified');
  g(clone, 'add', '-A'); const tree = g(clone, 'write-tree').trim();
  const oid = commitTreeRef(g, clone, 'ghost/ft', tree, base, 'ship');  // ghost/ft → the verified oid
  // normal ship: lands exactly the verified oid
  fetchBranchBack(src, clone, 'ghost/ship', oid);
  assert.equal(g(src, 'rev-parse', 'refs/heads/ghost/ship').trim(), oid);
  // TAMPER the destination branch name in the clone, but fetch by the VERIFIED oid (still reachable
  // via ghost/ft) — the source gets the exact verified commit, NOT the tampered base tip.
  g(clone, 'update-ref', 'refs/heads/ghost/tampered', base);
  fetchBranchBack(src, clone, 'ghost/tampered', oid);
  assert.equal(g(src, 'rev-parse', 'refs/heads/ghost/tampered').trim(), oid);   // verified commit, not base
  // FAIL CLOSED: if the verified object is gone/never existed, the fetch fails (nothing ships)
  assert.throws(() => fetchBranchBack(src, clone, 'ghost/gone', '0'.repeat(40)));
  fs.rmSync(clone, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});
