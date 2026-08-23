// src/dossier.mjs
// A per-repo snapshot: what it is, its git state, and — critically — the test runner that
// tells the Planner whether a card against it can even be graded unattended.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Read-only git introspection; swallow stderr so no-commit repos don't spew fatals.
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).toString();

// Which package manager runs this repo's scripts — the declared `packageManager` field wins, then
// the lockfile. Returning the WRONG one (always npm) meant a pnpm/yarn repo's `npm test` failed or
// even ran a different script; and runnerAvailable then checks the RIGHT binary is installed (round 28 #12).
export function detectPackageManager(repoPath, pkg) {
  const declared = String(pkg.packageManager || '').split('@')[0].toLowerCase();
  if (['pnpm', 'yarn', 'bun', 'npm'].includes(declared)) return declared;
  if (fs.existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(repoPath, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(repoPath, 'bun.lockb')) || fs.existsSync(path.join(repoPath, 'bun.lock'))) return 'bun';   // bun 1.2+ uses the text bun.lock
  return 'npm';   // package-lock.json or nothing → npm
}

// Detect the acceptance command as an argv array, or null if none is obvious.
export function detectTestRunner(repoPath) {
  const has = (f) => fs.existsSync(path.join(repoPath, f));
  const read = (f) => { try { return fs.readFileSync(path.join(repoPath, f), 'utf8'); } catch { return ''; } };

  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(read('package.json')); } catch { /* ignore */ }
    const t = pkg.scripts?.test;
    if (t && !/no test specified/i.test(t)) {
      const pm = detectPackageManager(repoPath, pkg);   // run the test SCRIPT with the declared manager
      return pm === 'bun' ? ['bun', 'run', 'test'] : pm === 'npm' ? ['npm', 'test'] : [pm, 'test'];
    }
    if (has('test') || has('tests')) return ['node', '--test'];
  }
  if (has('Cargo.toml')) return ['cargo', 'test'];
  if (has('go.mod')) return ['go', 'test', './...'];
  if (has('pyproject.toml') || has('setup.py') || has('pytest.ini') || has('tox.ini')) return ['pytest', '-q'];
  if (has('Makefile') && /(^|\n)test:/.test(read('Makefile'))) return ['make', 'test'];
  return null;
}

// Is the runner's executable actually on PATH? A detected runner whose binary isn't installed
// (e.g. a pyproject repo on a box with no pytest) would fail every unattended iteration, so it
// must NOT count as runnable (round 4 #11).
function realHasExe(bin) {
  try { execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; }
}
export function runnerAvailable(argv, { hasExe = realHasExe } = {}) {
  return Array.isArray(argv) && argv.length > 0 && hasExe(argv[0]);
}

// A repo using git-LFS (`filter=lfs`), any other clean/smudge FILTER, or a `working-tree-encoding`
// has its blobs transformed on a normal `git add`. The integrity snapshot ships the raw worktree
// bytes verbatim (to keep a hostile filter from executing in the daemon), which for these repos is
// NOT git's canonical blob — LFS would commit the whole file instead of the pointer. Declare such a
// repo unsupported rather than shipping a noncanonical tree (round 19 A2). `text=auto`/`eol` are NOT
// flagged: those are cosmetic line-ending normalizations, common and benign on an all-LF macOS repo.
export function usesTransformingFilters(repoPath) {
  if (fs.existsSync(path.join(repoPath, '.lfsconfig'))) return true;
  try {
    for (const line of fs.readFileSync(path.join(repoPath, '.gitattributes'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;                 // skip blanks + comments (round 21 #8)
      // A .gitattributes line is `pattern attr1 attr2 ...`. The FIRST token is the pathname pattern —
      // parse only the ATTRIBUTE tokens after it, so a file literally named `filter=lfs` (a valid
      // pattern) isn't mistaken for an active filter (round 22 #6). Only a fast pre-filter; the
      // verify-time git check-attr guard is authoritative for nested/config/candidate-added attrs.
      const attrs = t.split(/\s+/).slice(1);
      if (attrs.some(a => /^filter=/i.test(a) || /^working-tree-encoding=/i.test(a) || /^ident$/i.test(a))) return true;
    }
    return false;
  } catch { return false; }
}

export function scanRepo(repoPath, { gitRunner = git, hasExe = realHasExe } = {}) {
  const name = path.basename(repoPath.replace(/\/$/, ''));
  const testRunner = detectTestRunner(repoPath);
  // The package manager, surfaced independently of the runner — a JS repo detected as `node --test`
  // (test/ dir, no scripts.test) still needs its pm's install command granted, or the clone can't
  // bootstrap deps (round 33). null for a non-JS repo (cargo/go/pytest fetch their own).
  let packageManager = null;
  const pkgPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* malformed → lockfile fallback */ }
    packageManager = detectPackageManager(repoPath, pkg);
  }
  const runnerReady = testRunner ? runnerAvailable(testRunner, { hasExe }) : false;
  let branch = '', lastCommit = '', dirty = false, hasHead = false;
  try { branch = gitRunner(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { /* not a repo */ }
  try { lastCommit = gitRunner(repoPath, 'log', '-1', '--format=%h %s').trim(); } catch { /* empty */ }
  // Force untracked + submodule visibility (and disable fsmonitor) so status.showUntrackedFiles=no or a
  // submodule-ignore config can't hide the owner's WIP and suppress the dirty warning (round 22 #3).
  try { dirty = gitRunner(repoPath, '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none').trim().length > 0; } catch { /* ignore */ }
  // An UNBORN repo (git init, no commits) has no HEAD — a clone of it is empty and headRef's
  // `rev-parse HEAD` throws mid-run. There's nothing to work on, so it must not become a card;
  // mark it non-runnable with a clear reason instead of letting a card park on a cryptic error (round 18 #8).
  try { gitRunner(repoPath, 'rev-parse', '--verify', 'HEAD'); hasHead = true; } catch { /* unborn — no commits yet */ }
  const filtered = usesTransformingFilters(repoPath);
  return {
    name, repoPath, testRunner, runnerReady, packageManager,
    // Runnable unattended only if a runner is detected, its executable resolves, the repo has commits,
    // and it doesn't rely on check-in filters/LFS the snapshot can't reproduce (round 19 A2).
    canRunUnattended: Boolean(testRunner) && runnerReady && hasHead && !filtered,
    unrunnableReason: !hasHead ? 'repository has no commits yet — nothing to clone or work on'
                     : (filtered ? 'repo uses git-LFS or check-in filters — unsupported (the snapshot would ship noncanonical blobs)' : undefined),
    branch, lastCommit, dirty, unborn: !hasHead,
    hasResume: fs.existsSync(path.join(repoPath, 'RESUME.md')),
    hasTodo: fs.existsSync(path.join(repoPath, 'TODO.md')) || fs.existsSync(path.join(repoPath, 'TODO')),
    isGit: fs.existsSync(path.join(repoPath, '.git')),
  };
}

// Scan every immediate subdirectory of a dev root that is a git repo.
export function scanDevRoot(devRoot, opts = {}) {
  let names = [];
  try { names = fs.readdirSync(devRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
  return names
    .map(n => path.join(devRoot, n))
    .filter(p => fs.existsSync(path.join(p, '.git')))
    .map(p => scanRepo(p, opts));
}
