// src/dossier.mjs
// A per-repo snapshot: what it is, its git state, and — critically — the test runner that
// tells the Planner whether a card against it can even be graded unattended.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Read-only git introspection; swallow stderr so no-commit repos don't spew fatals.
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

// Detect the acceptance command as an argv array, or null if none is obvious.
export function detectTestRunner(repoPath) {
  const has = (f) => fs.existsSync(path.join(repoPath, f));
  const read = (f) => { try { return fs.readFileSync(path.join(repoPath, f), 'utf8'); } catch { return ''; } };

  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(read('package.json')); } catch { /* ignore */ }
    const t = pkg.scripts?.test;
    if (t && !/no test specified/i.test(t)) return ['npm', 'test'];
    if (has('test') || has('tests')) return ['node', '--test'];
  }
  if (has('Cargo.toml')) return ['cargo', 'test'];
  if (has('go.mod')) return ['go', 'test', './...'];
  if (has('pyproject.toml') || has('setup.py') || has('pytest.ini') || has('tox.ini')) return ['pytest', '-q'];
  if (has('Makefile') && /(^|\n)test:/.test(read('Makefile'))) return ['make', 'test'];
  return null;
}

export function scanRepo(repoPath, { gitRunner = git } = {}) {
  const name = path.basename(repoPath.replace(/\/$/, ''));
  const testRunner = detectTestRunner(repoPath);
  let branch = '', lastCommit = '', dirty = false;
  try { branch = gitRunner(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim(); } catch { /* not a repo */ }
  try { lastCommit = gitRunner(repoPath, 'log', '-1', '--format=%h %s').trim(); } catch { /* empty */ }
  try { dirty = gitRunner(repoPath, 'status', '--porcelain').trim().length > 0; } catch { /* ignore */ }
  return {
    name, repoPath, testRunner,
    canRunUnattended: Boolean(testRunner),
    branch, lastCommit, dirty,
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
