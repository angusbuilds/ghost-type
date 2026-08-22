// test/verifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance, netLinesGutted, patchApplied, classifyClaim, suspiciousDeletion, verifyCard, destructiveDiffReason, sterileTree, hasIgnoredState } from '../src/verifier.mjs';

test('sterileTree stores a symlink as a link blob (mode 120000, content=target), not by following it (round 15)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sl-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'target.txt'), 'the target content'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  fs.symlinkSync('target.txt', path.join(d, 'link'));   // candidate adds a symlink
  const tree = sterileTree(d);
  assert.match(execFileSync('git', ['ls-tree', tree, 'link'], { cwd: d }).toString(), /^120000 blob/);   // stored AS a symlink
  assert.equal(execFileSync('git', ['cat-file', '-p', `${tree}:link`], { cwd: d }).toString(), 'target.txt');  // content = target path, not followed
  fs.rmSync(d, { recursive: true, force: true });
});

test('sterileTree preserves a submodule GITLINK (mode 160000) — a repo with a submodule snapshots faithfully (round 16)', () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sm-'));
  const gm = (...a) => execFileSync('git', a, { cwd: main });
  gm('init', '-q'); gm('config', 'user.email', 't@t'); gm('config', 'user.name', 't');
  fs.writeFileSync(path.join(main, 'a.txt'), 'hi'); gm('add', '-A'); gm('commit', '-q', '-m', 'base');
  // a nested git repo → git records it as a gitlink when added
  const sub = path.join(main, 'sub'); fs.mkdirSync(sub);
  const gs = (...a) => execFileSync('git', a, { cwd: sub });
  gs('init', '-q'); gs('config', 'user.email', 't@t'); gs('config', 'user.name', 't');
  fs.writeFileSync(path.join(sub, 'x'), '1'); gs('add', '-A'); gs('commit', '-q', '-m', 'sub');
  const subHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sub }).toString().trim();
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'add', 'sub'], { cwd: main });   // add as gitlink
  const tree = sterileTree(main);
  const ls = execFileSync('git', ['ls-tree', tree, 'sub'], { cwd: main }).toString();
  assert.match(ls, /^160000 commit/);           // the gitlink is preserved, not refused or omitted
  assert.ok(ls.includes(subHead));              // pointing at the submodule's recorded commit
  fs.rmSync(main, { recursive: true, force: true });
});

test('sterileTree REFUSES a dirty submodule (worktree changed, HEAD unchanged) — its bytes drive the test but aren\'t in the tree, so shipping would silently drop them (round 17 a)', () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-smd-'));
  const gm = (...a) => execFileSync('git', a, { cwd: main });
  gm('init', '-q'); gm('config', 'user.email', 't@t'); gm('config', 'user.name', 't');
  fs.writeFileSync(path.join(main, 'a.txt'), 'hi'); gm('add', '-A'); gm('commit', '-q', '-m', 'base');
  const sub = path.join(main, 'sub'); fs.mkdirSync(sub);
  const gs = (...a) => execFileSync('git', a, { cwd: sub });
  gs('init', '-q'); gs('config', 'user.email', 't@t'); gs('config', 'user.name', 't');
  fs.writeFileSync(path.join(sub, 'x'), '1'); gs('add', '-A'); gs('commit', '-q', '-m', 'sub');
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'add', 'sub'], { cwd: main });   // gitlink
  // a BENIGN agent edits a file INSIDE the submodule but does not commit → HEAD still equals the
  // recorded gitlink (the HEAD-mismatch check passes), yet these bytes are what acceptance tested.
  fs.writeFileSync(path.join(sub, 'x'), 'MODIFIED-BYTES-THE-TEST-SEES');
  assert.throws(() => sterileTree(main), /submodule .*uncommitted changes/i);   // refuse, don't ship an empty change
  fs.rmSync(main, { recursive: true, force: true });
});

test('sterileTree snapshots a file→directory refactor (tracked file replaced by a dir) instead of refusing it as a special file (round 17 a)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-f2d-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'config'), 'old=1\n'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  // benign refactor: the tracked file `config` becomes a directory `config/` — an ordinary unstaged
  // worktree change. The old path is a deletion; its children arrive via ls-files --others.
  fs.rmSync(path.join(d, 'config')); fs.mkdirSync(path.join(d, 'config'));
  fs.writeFileSync(path.join(d, 'config', 'default.js'), 'export default { old: 1 };\n');
  let tree;
  assert.doesNotThrow(() => { tree = sterileTree(d); });                     // must NOT throw "special file (dir)"
  const ls = execFileSync('git', ['ls-tree', '-r', tree], { cwd: d }).toString();
  assert.match(ls, /\tconfig\/default\.js$/m);                              // the new file under the dir is captured
  assert.doesNotMatch(ls, /blob [0-9a-f]+\tconfig$/m);                      // the old file-at-path is gone, not a conflicting blob
  fs.rmSync(d, { recursive: true, force: true });
});

test('sterileTree snapshots a file whose NAME contains a newline (NUL-delimited index-info, not \\n-joined) (round 18 #12)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-nl-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'base'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const name = 'weird\nname.txt';                                    // a legal POSIX filename with an embedded newline
  fs.writeFileSync(path.join(d, name), 'newline-in-the-name');
  let tree;
  assert.doesNotThrow(() => { tree = sterileTree(d); });             // old \n-joined --index-info threw "malformed index info"
  const ls = execFileSync('git', ['ls-tree', '-r', '-z', tree], { cwd: d }).toString();
  assert.ok(ls.includes(name));                                      // the newline-named file is captured, not dropped/erroring
  fs.rmSync(d, { recursive: true, force: true });
});

// A gitlink whose submodule directory was replaced or removed must NOT ship the stale recorded commit.
function mkSubmoduleRepo(prefix) {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const gm = (...a) => execFileSync('git', a, { cwd: main });
  gm('init', '-q'); gm('config', 'user.email', 't@t'); gm('config', 'user.name', 't');
  fs.writeFileSync(path.join(main, 'a.txt'), 'hi'); gm('add', '-A'); gm('commit', '-q', '-m', 'base');
  const sub = path.join(main, 'sub'); fs.mkdirSync(sub);
  const gs = (...a) => execFileSync('git', a, { cwd: sub });
  gs('init', '-q'); gs('config', 'user.email', 't@t'); gs('config', 'user.name', 't');
  fs.writeFileSync(path.join(sub, 'x'), '1'); gs('add', '-A'); gs('commit', '-q', '-m', 'sub');
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'add', 'sub'], { cwd: main });   // record the gitlink
  return { main, sub };
}

test('sterileTree snapshots a gitlink REPLACED by a plain file, not the stale submodule commit (round 18 #3)', () => {
  const { main, sub } = mkSubmoduleRepo('gt-g2f-');
  fs.rmSync(sub, { recursive: true, force: true });
  fs.writeFileSync(sub, 'now-a-plain-file');                          // type change: gitlink dir → regular file
  const tree = sterileTree(main);
  const ls = execFileSync('git', ['ls-tree', tree, 'sub'], { cwd: main }).toString();
  assert.match(ls, /^100644 blob/);                                  // captured as the plain file...
  assert.doesNotMatch(ls, /160000/);                                 // ...not the stale 160000 gitlink
  fs.rmSync(main, { recursive: true, force: true });
});

test('sterileTree OMITS a gitlink whose submodule directory was deleted — a real deletion, not a preserved commit (round 18 #3)', () => {
  const { main, sub } = mkSubmoduleRepo('gt-gdel-');
  fs.rmSync(sub, { recursive: true, force: true });                  // deleted, nothing in its place
  const tree = sterileTree(main);
  const ls = execFileSync('git', ['ls-tree', tree, 'sub'], { cwd: main }).toString().trim();
  assert.equal(ls, '');                                              // gone from the tree, not a stale 160000
  fs.rmSync(main, { recursive: true, force: true });
});

test('sterileTree refuses a dirty submodule even when status.showUntrackedFiles=no would hide it (round 18 #4)', () => {
  const { main, sub } = mkSubmoduleRepo('gt-shide-');
  execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], { cwd: sub });   // blind default status...
  fs.writeFileSync(path.join(sub, 'sneaky.js'), 'untracked bytes the test can see');  // ...then dirty it, untracked-only
  assert.throws(() => sterileTree(main), /uncommitted changes/i);    // --untracked-files=all forces it visible → refuse
  fs.rmSync(main, { recursive: true, force: true });
});

test('verifyCard REFUSES an added/changed submodule gitlink — its nested commit can\'t be published, so shipping+reaping would lose it (round 19 A1)', async () => {
  const { main, sub } = mkSubmoduleRepo('gt-glchg-');
  const gm = (...a) => execFileSync('git', a, { cwd: main });
  gm('commit', '-q', '-m', 'base with submodule');                    // baseRef records the ORIGINAL gitlink
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: main }).toString().trim();
  // a BENIGN agent commits inside the submodule (moving its HEAD) and stages the new gitlink — clean, HEAD matches
  fs.writeFileSync(path.join(sub, 'x'), '2');
  execFileSync('git', ['add', '-A'], { cwd: sub }); execFileSync('git', ['commit', '-q', '-m', 'sub update'], { cwd: sub });
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'add', 'sub'], { cwd: main });   // stage the NEW gitlink oid
  const v = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'update the submodule', branch: 'ghost/x' }, main, { baseRef: base });
  assert.equal(v.pass, false);
  assert.match(v.detail.testOutput, /modification is unsupported|submodule .* was changed/i);
  fs.rmSync(main, { recursive: true, force: true });
});

test('verifyCard REFUSES a DELETED submodule gitlink, not just an added/changed one (round 22 #2)', async () => {
  const { main, sub } = mkSubmoduleRepo('gt-gdel2-');
  const gm = (...a) => execFileSync('git', a, { cwd: main });
  gm('commit', '-q', '-m', 'base with submodule');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: main }).toString().trim();
  fs.rmSync(sub, { recursive: true, force: true });                  // worktree removal → sterileTree omits the gitlink
  fs.writeFileSync(path.join(main, 'a.txt'), 'changed');             // a normal change so the diff isn't empty
  const v = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'remove the submodule', branch: 'ghost/x' }, main, { baseRef: base });
  assert.equal(v.pass, false);                                       // old mode 160000 (deletion) is now caught
  assert.match(v.detail.testOutput, /modification is unsupported|submodule .* was changed/i);
  fs.rmSync(main, { recursive: true, force: true });
});

test('sterileTree REFUSES a gitlink dir with content but no .git (populated, not initialized), keeps an EMPTY one (round 22 #1)', () => {
  const { main, sub } = mkSubmoduleRepo('gt-guninit-');
  fs.rmSync(path.join(sub, '.git'), { recursive: true, force: true });   // populated (still has 'x') but not initialized
  assert.throws(() => sterileTree(main), /content but is not an initialized submodule/i);
  fs.rmSync(main, { recursive: true, force: true });

  const { main: m2, sub: s2 } = mkSubmoduleRepo('gt-gempty-');
  fs.rmSync(path.join(s2, '.git'), { recursive: true, force: true }); fs.rmSync(path.join(s2, 'x'));   // now genuinely empty
  assert.doesNotThrow(() => sterileTree(m2));                        // an empty uninitialized gitlink dir is faithfully kept
  fs.rmSync(m2, { recursive: true, force: true });
});

test('sterileTree REFUSES a case-only rename done outside git (index foo.js, disk Foo.js) on a case-insensitive FS (round 23)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-case-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'foo.js'), 'export const x = 1;'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  fs.renameSync(path.join(d, 'foo.js'), path.join(d, 'Foo.js'));     // case-only rename WITHOUT git mv
  if (fs.existsSync(path.join(d, 'foo.js'))) {                       // case-insensitive FS (macOS): foo.js resolves to Foo.js
    assert.throws(() => sterileTree(d), /case-only rename|on-disk spelling/i);   // the index/disk mismatch is refused
  } else {                                                          // case-sensitive FS: it's a plain delete+add, no mismatch
    assert.doesNotThrow(() => sterileTree(d));
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('sterileTree REFUSES a case-only rename of a SUBMODULE directory (the gitlink path bypasses addWorktree) (round 25)', () => {
  const { main } = mkSubmoduleRepo('gt-subcase-');
  fs.renameSync(path.join(main, 'sub'), path.join(main, 'Sub'));    // case-only rename of the gitlink dir, no git mv
  if (fs.existsSync(path.join(main, 'sub'))) {                      // case-insensitive FS: sub resolves to Sub
    assert.throws(() => sterileTree(main), /case-only rename|on-disk spelling/i);   // gitlink-path case check refuses it
  } else {
    assert.throws(() => sterileTree(main));                         // case-sensitive: Sub is an untracked nested repo → also refused
  }
  fs.rmSync(main, { recursive: true, force: true });
});

test('sterileTree REFUSES a PARENT-directory case-only rename (mv src Src), not just a leaf filename (round 24)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-casedir-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src', 'value.mjs'), 'export const v = 1;');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  fs.renameSync(path.join(d, 'src'), path.join(d, 'Src'));           // case-only rename of the DIRECTORY, no git mv
  if (fs.existsSync(path.join(d, 'src', 'value.mjs'))) {             // case-insensitive FS: src/ resolves to Src/
    assert.throws(() => sterileTree(d), /case-only rename|on-disk spelling/i);   // parent-component mismatch is refused
  } else {
    assert.doesNotThrow(() => sterileTree(d));                       // case-sensitive FS: plain dir delete+add
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('sterileTree REFUSES an untracked nested git repository — its content would otherwise be silently dropped (round 21 #1)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-nested-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.js'), '1'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const nested = path.join(d, 'vendored'); fs.mkdirSync(nested);      // an untracked NESTED repo with real content
  execFileSync('git', ['init', '-q'], { cwd: nested });
  fs.writeFileSync(path.join(nested, 'lib.js'), 'nested content ls-files --others reports as a dir');
  assert.throws(() => sterileTree(d), /nested git repository/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('patchApplied compares the sterile tree to base, seeing a candidate that status.showUntrackedFiles=no would hide (round 21 #5)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pa5-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.js'), '1'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  assert.equal(patchApplied(d, base), false);                        // unchanged worktree → no patch
  g('config', 'status.showUntrackedFiles', 'no');                    // config that would blind `git status`
  fs.writeFileSync(path.join(d, 'feature.js'), 'a new untracked candidate the status would hide');
  assert.equal(patchApplied(d, base), true);                         // sterile-tree vs base-tree still sees it
  fs.rmSync(d, { recursive: true, force: true });
});

test('hasIgnoredState is true when a populated submodule exists (its ignored deps are invisible to outer status) (round 21 #2)', () => {
  const { main } = mkSubmoduleRepo('gt-subig-');                     // main holds a populated submodule 'sub'
  assert.equal(hasIgnoredState(main), true);                         // conservatively preserved, not reaped
  fs.rmSync(main, { recursive: true, force: true });
});

test('verifyCard REFUSES a non-ignored EMPTY directory git can\'t represent (false pass on fresh checkout), allows an ignored one (round 26)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-emptydir-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.js'), '1'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  fs.writeFileSync(path.join(d, 'feature.js'), 'the shipped change');   // a real change...
  fs.mkdirSync(path.join(d, 'runtime'));                                // ...+ a non-ignored EMPTY dir the test might need
  const v = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'add feature', branch: 'ghost/x' }, d, { baseRef: base });
  assert.equal(v.pass, false);
  assert.match(v.detail.testOutput, /empty director|\.gitkeep/i);
  // an IGNORED empty dir is fine — its absence from the tree is intended, not a false pass
  fs.rmSync(path.join(d, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(d, '.gitignore'), 'cache/\n'); fs.mkdirSync(path.join(d, 'cache'));
  const v2 = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'add feature', branch: 'ghost/x' }, d, { baseRef: base });
  assert.equal(v2.pass, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('verifyCard REFUSES an empty candidate (frozen tree identical to base) — no empty commit ships, no real commit lost (round 20 #4)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-empty-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.js'), 'export const x = 1;'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  const v = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'do something', branch: 'ghost/x' }, d, { baseRef: base });
  assert.equal(v.pass, false);                                       // worktree == base → frozen tree == base → nothing to ship
  assert.match(v.detail.testOutput, /identical to the base|empty change/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('verifyCard catches a changed gitlink even when diff.ignoreSubmodules=all would hide it (round 20 #1)', async () => {
  const { main, sub } = mkSubmoduleRepo('gt-igsub-');
  const gm = (...a) => execFileSync('git', a, { cwd: main });
  gm('commit', '-q', '-m', 'base with submodule');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: main }).toString().trim();
  gm('config', 'diff.ignoreSubmodules', 'all');                     // config that would blind a plain diff
  fs.writeFileSync(path.join(sub, 'x'), '2');
  execFileSync('git', ['add', '-A'], { cwd: sub }); execFileSync('git', ['commit', '-q', '-m', 'sub v2'], { cwd: sub });
  gm('-c', 'protocol.file.allow=always', 'add', 'sub');             // stage the new gitlink...
  fs.writeFileSync(path.join(main, 'a.txt'), 'changed');            // ...plus a normal change so the diff isn't empty
  const v = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'update', branch: 'ghost/x' }, main, { baseRef: base });
  assert.equal(v.pass, false);                                      // --ignore-submodules=none overrides the config → gitlink seen → refused
  assert.match(v.detail.testOutput, /modification is unsupported|submodule .* was changed/i);
  fs.rmSync(main, { recursive: true, force: true });
});

test('verifyCard refuses an effective filter attribute from a NESTED/candidate-added .gitattributes the scan misses (round 20 #2)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-attr-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.js'), 'export const x = 1;'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  // the candidate adds a NESTED .gitattributes applying an LFS filter + a matching file (root scan misses this)
  fs.mkdirSync(path.join(d, 'assets'));
  fs.writeFileSync(path.join(d, 'assets', '.gitattributes'), '*.bin filter=lfs -text\n');
  fs.writeFileSync(path.join(d, 'assets', 'model.bin'), 'BINARY-BYTES');
  const v = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'add a model', branch: 'ghost/x' }, d, { baseRef: base });
  assert.equal(v.pass, false);
  assert.match(v.detail.testOutput, /effective 'filter|check-in attribute|noncanonical/i);
  fs.rmSync(d, { recursive: true, force: true });
});

test('verifyCard does NOT refuse a candidate that DELETES an LFS/filtered file — it is not in the shipped tree (round 29)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-delfilter-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, '.gitattributes'), '*.bin filter=lfs -text\n');
  fs.writeFileSync(path.join(d, 'asset.bin'), 'BINARY'); fs.writeFileSync(path.join(d, 'a.js'), '1');
  g('add', '-A'); g('commit', '-q', '-m', 'base with an LFS asset');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  fs.rmSync(path.join(d, 'asset.bin'));                    // delete the ONLY filtered file (worktree deletion, still in index)
  fs.writeFileSync(path.join(d, 'feature.js'), 'the real change');
  const v = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'remove the asset', branch: 'ghost/x' }, d, { baseRef: base });
  assert.equal(v.pass, true);   // deleted filtered file isn't in the shipped tree → the old ls-files enumeration wrongly refused it
  fs.rmSync(d, { recursive: true, force: true });
});

test('hasIgnoredState is true for ANY ignored state incl. inside a dep dir (no allowlist bypass), false when clean (round 20 #3)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-his-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules/\ndata.json\n');
  fs.writeFileSync(path.join(d, 'a.js'), '1'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  assert.equal(hasIgnoredState(d), false);                           // clean: nothing ignored present → reap-safe
  fs.mkdirSync(path.join(d, 'node_modules')); fs.writeFileSync(path.join(d, 'node_modules', 'evil.json'), 'the round-19 bypass');
  assert.equal(hasIgnoredState(d), true);                            // even inside node_modules → preserved, no allowlist to bypass
  fs.rmSync(d, { recursive: true, force: true });
});

test('verifyCard reports hadIgnoredState so the caller can decide whether reaping the clone is safe (round 20 #3)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hadig-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.js'), '1'); fs.writeFileSync(path.join(d, '.gitignore'), 'secret.dat\n'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  fs.writeFileSync(path.join(d, 'feature.js'), 'the shipped change');            // a real (untracked, additive) change
  const clean = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'add feature', branch: 'ghost/x' }, d, { baseRef: base });
  assert.equal(clean.pass, true); assert.equal(clean.hadIgnoredState, false);    // no ignored state → clone is reap-safe
  fs.writeFileSync(path.join(d, 'secret.dat'), 'agent-created ignored input the test might read');
  const dirty = await verifyCard({ acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, goal: 'add feature', branch: 'ghost/x' }, d, { baseRef: base });
  assert.equal(dirty.pass, true); assert.equal(dirty.hadIgnoredState, true);     // ignored state present → preserve the clone
  fs.rmSync(d, { recursive: true, force: true });
});

test('sterileTree does NOT hang on an untracked FIFO — git omits it from ls-files (round 16)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-fifo-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'hi'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  execFileSync('mkfifo', [path.join(d, 'pipe')]);          // git ls-files won't list this...
  fs.writeFileSync(path.join(d, 'real.js'), 'export const x = 1;');   // ...but there's a real candidate change
  let tree;
  assert.doesNotThrow(() => { tree = sterileTree(d); });   // completes instead of blocking on hash-object <fifo>
  assert.ok(tree);
  // the (isFile()) special-file guard still refuses one that IS listed (defends a listing→lstat race)
  fs.rmSync(d, { recursive: true, force: true });
});

test('sterileTree hashes DISK bytes, defeating the assume-unchanged index trick (round 15 High)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-st-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'original'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  // mark a.txt assume-unchanged, then change it on disk — a plain `git add` would keep the OLD blob
  g('update-index', '--assume-unchanged', 'a.txt');
  fs.writeFileSync(path.join(d, 'a.txt'), 'THE-BYTES-THE-TEST-ACTUALLY-SEES');
  const tree = sterileTree(d);
  const blob = execFileSync('git', ['cat-file', '-p', `${tree}:a.txt`], { cwd: d }).toString();
  assert.match(blob, /THE-BYTES-THE-TEST-ACTUALLY-SEES/);   // frozen tree = disk content, not the stale index blob
  fs.rmSync(d, { recursive: true, force: true });
});
import { sandboxNetDeny, sandboxWriteConfine } from '../src/sandbox.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpGit() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pa-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'hi'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  return d;
}

test('patchApplied is false when nothing changed, true after an edit', () => {
  const d = tmpGit();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  assert.equal(patchApplied(d, base), false);
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed');
  assert.equal(patchApplied(d, base), true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('classifyClaim flags false-done when the agent claims done but tests fail', () => {
  assert.deepEqual(classifyClaim({ claimText: 'All tests pass, done!', verifyPass: false }), { claimedDone: true, falseDone: true });
  assert.deepEqual(classifyClaim({ claimText: 'done', verifyPass: true }), { claimedDone: true, falseDone: false });
  assert.deepEqual(classifyClaim({ claimText: 'I could not fix it', verifyPass: false }), { claimedDone: false, falseDone: false });
});

test('runAcceptance passes on exit 0', async () => {
  const r = await runAcceptance(['node', '-e', 'process.exit(0)'], process.cwd(), 30);
  assert.equal(r.pass, true);
  assert.equal(r.code, 0);
});

test('runAcceptance fails on nonzero exit and captures stderr head', async () => {
  const r = await runAcceptance(['node', '-e', 'console.error("boom"); process.exit(1)'], process.cwd(), 30);
  assert.equal(r.pass, false);
  assert.match(r.stderrHead, /boom/);
});

test('runAcceptance times out', async () => {
  const r = await runAcceptance(['node', '-e', 'setTimeout(()=>{}, 10000)'], process.cwd(), 1);
  assert.equal(r.pass, false);
  assert.equal(r.timedOut, true);
});

test('runAcceptance drains a chatty stdout instead of deadlocking (round 5 M1)', async () => {
  // Write ~2MB to stdout then exit 0 — would block on a full pipe if stdout were unconsumed.
  const r = await runAcceptance(['node', '-e', 'process.stdout.write("x".repeat(2_000_000)); process.exit(0)'], process.cwd(), 20);
  assert.equal(r.pass, true);       // completed, not a false timeout
  assert.equal(r.timedOut, false);
});

test('runAcceptance captures a failure reported on STDOUT, not just stderr (round 5 M1)', async () => {
  const r = await runAcceptance(['node', '-e', 'console.log("FAIL: expected 2 got 3"); process.exit(1)'], process.cwd(), 20);
  assert.equal(r.pass, false);
  assert.match(r.stderrHead, /FAIL: expected 2/);   // stdout diagnostics are now surfaced
});

test('runAcceptance runs with a credential-stripped environment (round 6 #1)', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'super-secret';
  try {
    // the test command "fails" (exit 1) only if it can see the key — it should NOT
    const r = await runAcceptance(['node', '-e', 'process.exit(process.env.ANTHROPIC_API_KEY ? 1 : 0)'], process.cwd(), 20);
    assert.equal(r.pass, true, 'acceptance env leaked ANTHROPIC_API_KEY');
  } finally { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; }
});

test('runAcceptance kills the whole process group on timeout — a grandchild cannot deadlock it (round 6 #1)', async () => {
  const start = Date.now();
  // parent spawns a grandchild that INHERITS stdout and never exits, then the parent hangs too.
  const script = "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000);";
  const r = await runAcceptance(['node', '-e', script], process.cwd(), 1);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - start < 6000, 'returned promptly — the grandchild did not hold it open');
});

test('runAcceptance settles at the deadline even when a grandchild ESCAPES the process group (round 7 High#1)', async () => {
  const start = Date.now();
  // grandchild is spawned DETACHED (its own group) inheriting stdout — it survives kill(-pid),
  // so 'close' is delayed ~3s. We must still resolve at the ~1s deadline, not wait for it.
  const script = "const{spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:'inherit',detached:true});g.unref();setInterval(()=>{},1000);";
  const r = await runAcceptance(['node', '-e', script], process.cwd(), 1);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - start < 2500, `settled at the deadline, not on the grandchild's exit (${Date.now() - start}ms)`);
});

test('verifyCard refuses a destructive diff even when the test passes (round 5 H1)', async () => {
  const d = tmpGit();
  // the feature exists AT base...
  fs.writeFileSync(path.join(d, 'feature.js'), Array.from({ length: 80 }, (_, i) => `const l${i}=${i};`).join('\n'));
  execFileSync('git', ['add', '-A'], { cwd: d }); execFileSync('git', ['commit', '-q', '-m', 'feature'], { cwd: d });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  // ...then the "agent" guts it while the (trivial) test still passes
  fs.writeFileSync(path.join(d, 'feature.js'), 'const l0=0;');
  const card = { goal: 'add a gallery feature', acceptanceArgv: ['node', '-e', 'process.exit(0)'], acceptanceTimeoutSec: 20 };
  const v = await verifyCard(card, d, { baseRef: base });
  assert.equal(v.pass, false);
  assert.match(v.detail.testOutput, /net-negative|refusing/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('sandboxNetDeny wraps acceptance in a network-denied jail on macOS, no-ops elsewhere (round 8)', () => {
  const wrapped = sandboxNetDeny(['npm', 'test'], { home: '/Users/x', platform: 'darwin' });
  assert.equal(wrapped[0], 'sandbox-exec');
  assert.equal(wrapped[1], '-p');
  assert.match(wrapped[2], /\(deny network\*\)/);
  assert.match(wrapped[2], /\/Users\/x\/\.ssh/);
  assert.deepEqual(wrapped.slice(-2), ['npm', 'test']);   // original command preserved at the tail
  assert.deepEqual(sandboxNetDeny(['npm', 'test'], { platform: 'linux' }), ['npm', 'test']);   // no-op off macOS
});

test('sandboxWriteConfine confines writes to the clone but ALLOWS network (round 8 Critical)', () => {
  const wrapped = sandboxWriteConfine(['claude', '-p', 'x'], '/work/clone-1', { home: '/Users/x', platform: 'darwin', tmpdir: '/tmp' });
  assert.equal(wrapped[0], 'sandbox-exec');
  assert.doesNotMatch(wrapped[2], /deny network/);        // the coding agent's API must still work
  assert.match(wrapped[2], /\(deny file-write\*\)/);
  assert.match(wrapped[2], /subpath "\/work\/clone-1"/);  // writes allowed under the clone
  assert.match(wrapped[2], /Library\/pnpm/);              // + package-manager stores so deps can install under sandbox (round 28 #12b)
  assert.match(wrapped[2], /\.bun/);
  assert.doesNotMatch(wrapped[2], /\.ssh|\.aws|\.gnupg/); // sensitive stores are NOT write-allowed
  assert.deepEqual(wrapped.slice(-3), ['claude', '-p', 'x']);
  assert.deepEqual(sandboxWriteConfine(['claude'], '/c', { platform: 'linux' }), ['claude']);   // no-op off macOS
  assert.deepEqual(sandboxWriteConfine(['claude'], null, { platform: 'darwin' }), ['claude']);  // no clone → no-op
});

test('runAcceptance under the sandbox still passes a normal (non-network) test', { skip: process.platform !== 'darwin' }, async () => {
  const r = await runAcceptance(['node', '-e', 'process.exit(0)'], process.cwd(), 15, undefined, true);
  assert.equal(r.pass, true);   // the jail doesn't break an ordinary test
});

test('verifyCard passes a clean additive diff (round 5 H1)', async () => {
  const d = tmpGit();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  fs.writeFileSync(path.join(d, 'feature.js'), 'export const feature = () => 42;');
  const card = { goal: 'add a feature', acceptanceArgv: ['node', '-e', 'process.exit(0)'], acceptanceTimeoutSec: 20 };
  const v = await verifyCard(card, d, { baseRef: base });
  assert.equal(v.pass, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('netLinesGutted flags a net-negative diff', () => {
  assert.equal(netLinesGutted(' 3 files changed, 2 insertions(+), 40 deletions(-)'), true);
  assert.equal(netLinesGutted(' 3 files changed, 40 insertions(+), 2 deletions(-)'), false);
});

test('suspiciousDeletion catches a net-negative diff on a build goal, ignores refactors', () => {
  const gutted = ' 1 file changed, 2 insertions(+), 90 deletions(-)';
  assert.equal(suspiciousDeletion('add a lazy-load feature to the gallery', gutted), true);
  assert.equal(suspiciousDeletion('remove the dead code path', gutted), false);   // deletion IS the goal
  assert.equal(suspiciousDeletion('add a feature', ' 1 file changed, 90 insertions(+), 2 deletions(-)'), false);
});

test('destructiveDiffReason catches gutting under a non-build goal and deleted tests (round 6 #3)', () => {
  // "fix" goal (no build word) that guts a file 500→1 — old guard missed this
  assert.match(destructiveDiffReason('fix the parser', '1\t500\tsrc/parser.js', 'M\tsrc/parser.js'), /500 net lines|lost/);
  // padded net-POSITIVE total (501 add / 500 del) but a test file is deleted
  assert.match(destructiveDiffReason('make it pass', '501\t0\tpad.js\n0\t500\ttest/core.test.js', 'A\tpad.js\nD\ttest/core.test.js'), /deletes test file/);
  // an explicit deletion goal is allowed
  assert.equal(destructiveDiffReason('remove the dead module', '0\t400\told.js', 'D\told.js'), null);
  // a normal additive change is clean
  assert.equal(destructiveDiffReason('add a feature', '40\t3\tsrc/feature.js', 'A\tsrc/feature.js'), null);
});

test('destructiveDiffReason closes the round-7 High#4 bypasses', () => {
  // root-level test file (test_parser.py) — not in a test/ dir
  assert.match(destructiveDiffReason('make it green', '0\t50\ttest_parser.py', 'D\ttest_parser.py'), /deletes test file/);
  // a deletion WORD present but not the intent ("add X and remove the stub") still catches a test deletion
  assert.match(destructiveDiffReason('add lazy-load and remove the stub', '10\t5\tsrc/x.js\n0\t40\tsrc/core.test.js', 'M\tsrc/x.js\nD\tsrc/core.test.js'), /deletes test file/);
  // deletions SPLIT across files (no single file >100) — aggregate catches it
  assert.match(destructiveDiffReason('fix the build', '0\t60\ta.js\n0\t60\tb.js\n0\t60\tc.js', 'M\ta.js\nM\tb.js\nM\tc.js'), /across files/);
  // EXACTLY 100 net deletions in one file
  assert.match(destructiveDiffReason('fix it', '0\t100\tbig.js', 'M\tbig.js'), /100 net lines/);
  // renaming a test OUT of discovery
  assert.match(destructiveDiffReason('refactor', '0\t0\tx', 'R100\tsrc/core.test.js\tsrc/core.js'), /out of test discovery/);
  // an explicit TEST goal may legitimately remove a test
  assert.equal(destructiveDiffReason('remove the flaky parser test', '0\t40\tsrc/parser.test.js', 'D\tsrc/parser.test.js'), null);
});

test('destructiveDiffReason closes the round-8 bypasses: binary + more Node test names', () => {
  // deleting a large BINARY asset (numstat shows -\t-) under a non-deletion goal
  assert.match(destructiveDiffReason('fix parser', '-\t-\tassets/model.bin', 'D\tassets/model.bin'), /binary asset/);
  // Node-discovered test names the old TESTISH missed: parser-test.js and root test.js
  assert.match(destructiveDiffReason('make green', '0\t30\tparser-test.js', 'D\tparser-test.js'), /deletes test file/);
  assert.match(destructiveDiffReason('make green', '0\t30\ttest.js', 'D\ttest.js'), /deletes test file/);
  // a deletion goal still allows removing a stale binary
  assert.equal(destructiveDiffReason('remove the old model asset', '-\t-\tassets/model.bin', 'D\tassets/model.bin'), null);
});

test('destructiveDiffReason closes the round-9 exemption bypasses', () => {
  // "fix the failing parser test" mentions "test" but has no deletion intent → deleting the test is refused
  assert.match(destructiveDiffReason('fix the failing parser test', '0\t40\tparser.test.js', 'D\tparser.test.js'), /deletes test file/);
  // a MIXED goal ("fix ... and remove ...") must not disable the size guard
  assert.match(destructiveDiffReason('fix parser and remove a debug log', '0\t1000\tsrc/parser.js', 'M\tsrc/parser.js'), /1000 net lines/);
  // ...nor the binary guard
  assert.match(destructiveDiffReason('fix parser and remove a debug log', '-\t-\tassets/model.bin', 'D\tassets/model.bin'), /binary asset/);
  // Node's test-<name>.mjs prefix is recognized
  assert.match(destructiveDiffReason('make green', '0\t30\tsrc/test-parser.mjs', 'D\tsrc/test-parser.mjs'), /deletes test file/);
  // explicit test-removal intent (deletion word + test) is still allowed
  assert.equal(destructiveDiffReason('remove the flaky parser test', '0\t40\tparser.test.js', 'D\tparser.test.js'), null);
});

test('destructiveDiffReason closes the round-10 lexical gaps', () => {
  // "repair" now counts as fix intent → not a pure deletion → 1000-line gut is caught
  assert.match(destructiveDiffReason('repair parser and remove a debug log', '0\t1000\tsrc/parser.js', 'M\tsrc/parser.js'), /1000 net lines/);
  // deletion + test words in DIFFERENT clauses no longer exempt a test deletion (proximity required)
  assert.match(destructiveDiffReason('remove debug logging and fix parser tests', '0\t40\tparser.test.js', 'D\tparser.test.js'), /deletes test file/);
});

test('destructiveDiffReason closes the round-11 lexical gaps', () => {
  // clause breaks "while"/"so" now separate the deletion word from the test word → not exempt
  assert.match(destructiveDiffReason('remove debug output while fixing parser tests', '0\t40\tparser.test.js', 'D\tparser.test.js'), /deletes test file/);
  assert.match(destructiveDiffReason('remove debug output so parser tests pass', '0\t40\tparser.test.js', 'D\tparser.test.js'), /deletes test file/);
  // "refactor" now counts as build/fix intent → a 1000-line gut is not a pure deletion → caught
  assert.match(destructiveDiffReason('refactor parser and remove dead code', '0\t1000\tsrc/parser.js', 'M\tsrc/parser.js'), /1000 net lines/);
});

test('verifyCard REFUSES a candidate with an effective clean filter — never executes it, never ships noncanonical bytes (round 14 mechanism + round 20 #2)', async () => {
  const d = tmpGit();
  const g = (...a) => execFileSync('git', a, { cwd: d });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  // a clean filter that would replace ALL content with "PWNED" (arbitrary code on `git add`)
  g('config', 'filter.evil.clean', 'sed "s/.*/PWNED/"');
  fs.writeFileSync(path.join(d, '.gitattributes'), 'feature.js filter=evil\n');
  fs.writeFileSync(path.join(d, 'feature.js'), 'the real tested content');
  const card = { goal: 'add a feature', acceptanceArgv: ['node', '-e', 'process.exit(0)'], acceptanceTimeoutSec: 20 };
  const v = await verifyCard(card, d, { baseRef: base });
  assert.equal(v.pass, false);                                  // a filtered candidate is now REFUSED, not shipped (round 20 #2)
  assert.match(v.detail.testOutput, /filter|check-in attribute/i);
  // and the round-14 mechanism still holds: sterileTree hashes RAW bytes — the filter is NEVER executed
  const tree = sterileTree(d);
  const blob = execFileSync('git', ['cat-file', '-p', `${tree}:feature.js`], { cwd: d }).toString();
  assert.match(blob, /the real tested content/);
  assert.doesNotMatch(blob, /PWNED/);                           // the malicious clean filter never ran
  fs.rmSync(d, { recursive: true, force: true });
});

test('verifyCard fails CLOSED when it cannot snapshot the candidate tree (round 12 High)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-nogit-'));   // NOT a git repo → freeze fails
  const card = { goal: 'add a feature', acceptanceArgv: ['node', '-e', 'process.exit(0)'], acceptanceTimeoutSec: 20 };
  const v = await verifyCard(card, d, { baseRef: 'HEAD' });
  assert.equal(v.pass, false);   // a freeze failure must refuse, not skip the mutation check
  assert.match(v.detail.testOutput, /could not snapshot|refusing/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('verifyCard refuses a test that ERASES an UNTRACKED candidate file (round 11 High)', async () => {
  const d = tmpGit();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  fs.writeFileSync(path.join(d, 'feature.js'), 'export const f = () => 1;');   // UNTRACKED new candidate file
  // a rigged test that deletes the (untracked) candidate then exits 0 — the round-10 filename check missed this
  const card = {
    goal: 'add a feature',
    acceptanceArgv: ['node', '-e', 'require("fs").unlinkSync("feature.js"); process.exit(0)'],
    acceptanceTimeoutSec: 20,
  };
  const v = await verifyCard(card, d, { baseRef: base });
  assert.equal(v.pass, false);                       // erased the untracked patch → tree changed → refused
  assert.match(v.detail.testOutput, /changed the candidate tree/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('verifyCard refuses a test that CORRUPTS the candidate in place (round 11 High)', async () => {
  const d = tmpGit();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  fs.writeFileSync(path.join(d, 'feature.js'), 'export const good = () => 42;');
  const card = {
    goal: 'add a feature',
    acceptanceArgv: ['node', '-e', 'require("fs").writeFileSync("feature.js","garbage"); process.exit(0)'],   // rewrites content, same path
    acceptanceTimeoutSec: 20,
  };
  const v = await verifyCard(card, d, { baseRef: base });
  assert.equal(v.pass, false);                       // content changed → different tree hash → refused
  fs.rmSync(d, { recursive: true, force: true });
});

test('verifyCard passes an untracked additive candidate when the test writes only GITIGNORED artifacts', async () => {
  const d = tmpGit();
  fs.writeFileSync(path.join(d, '.gitignore'), 'coverage.out\n');   // artifacts are ignored, as in a real repo
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('add', '-A'); g('commit', '-q', '-m', 'add gitignore');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  fs.writeFileSync(path.join(d, 'feature.js'), 'export const f = () => 1;');   // untracked candidate
  const card = {
    goal: 'add a feature',
    acceptanceArgv: ['node', '-e', 'require("fs").writeFileSync("coverage.out","ok"); process.exit(0)'],   // ignored artifact → no tree change
    acceptanceTimeoutSec: 20,
  };
  const v = await verifyCard(card, d, { baseRef: base });
  assert.equal(v.pass, true);   // the candidate survived; the ignored artifact didn't count
  fs.rmSync(d, { recursive: true, force: true });
});
