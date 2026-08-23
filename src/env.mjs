// src/env.mjs

// Non-credential vars any coding session legitimately needs. Everything else is dropped
// unless the card explicitly re-admits it via extraAllow.
const COMMON_ALLOW = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'NODE_ENV'];

// ONLY the selected engine's provider credentials are admitted — a Codex run must never
// receive Anthropic keys, nor a Claude run receive OpenAI keys (round 5 M9).
const ENGINE_CREDS = {
  // ANTHROPIC_AUTH_TOKEN is a supported Claude Code auth method — listing it both admits it to a
  // Claude session (else auth-token users' sessions fail) AND puts it in ALL_ENGINE_CREDS so
  // extraAllow can't smuggle it into a Codex run (round 31 fuzz found both gaps).
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
};

// engine 'none' (or any non-provider value) admits ZERO credentials — used for running an
// untrusted acceptance test, which never needs a provider key (round 6 #1). An unknown engine
// failing closed (no creds) is safer than defaulting to a provider's keys.
const ALL_ENGINE_CREDS = new Set(Object.values(ENGINE_CREDS).flat());
export function buildSessionEnv(extraAllow = [], src = process.env, engine = 'claude') {
  // extraAllow can re-admit app vars (DATABASE_URL, …) but NEVER another engine's provider key — else
  // a misconfigured card could leak Anthropic keys into a Codex run, breaking credential isolation (round 29).
  const cleanExtra = extraAllow.filter(k => !ALL_ENGINE_CREDS.has(k));
  const allow = new Set([...COMMON_ALLOW, ...(ENGINE_CREDS[engine] || []), ...cleanExtra]);
  const out = {};
  for (const [k, v] of Object.entries(src)) if (allow.has(k)) out[k] = v;
  out.GHOST_SESSION = '1';
  return out;
}

// Dependency-install commands per package manager. A fresh `git clone` omits gitignored dependency
// dirs (node_modules/.venv), so WITHOUT allowing install the agent can't bootstrap them and the
// acceptance test can never pass on any deps-needing repo (round 28 #12b — the test runner alone was
// insufficient). Scoped to install/sync verbs — never publish/deploy/exec-arbitrary.
// Bootstrapping the clone's EXISTING deps needs only a lockfile install (no package argument), so keep
// these to no-arg / requirements-scoped forms — a bare `install *` wildcard would widen the command
// surface for little benefit (round 29). cargo/go/make fetch their own deps during the test run.
const INSTALL_CMDS = {
  npm: ['Bash(npm install)', 'Bash(npm ci)'],
  pnpm: ['Bash(pnpm install)', 'Bash(pnpm i)'],
  yarn: ['Bash(yarn install)', 'Bash(yarn)'],
  bun: ['Bash(bun install)'],
  pytest: ['Bash(pip install -r *)', 'Bash(python -m pip install -r *)', 'Bash(uv sync)'],
};

// Build the --allowedTools value: reads/edits/writes, the exact test runner as a Bash command, the
// package manager's INSTALL command (so the clone's missing deps can be bootstrapped), and git
// plumbing that can never push. No gh/curl/deploy/publish.
export function allowedToolsFor(testRunnerArgv, packageManager = null) {
  const runner = testRunnerArgv.join(' ');
  // Grant the install command for BOTH the acceptance command's own tool (npm/pnpm/yarn/bun/pytest) AND
  // the repo's package manager — they diverge when a JS repo has a test/ dir but no scripts.test, detected
  // as `node --test`: node has no INSTALL_CMDS entry, so without the pm the clone could never bootstrap its
  // gitignored deps and burned the whole budget on MODULE_NOT_FOUND every night (round 33). Deduped.
  const installs = [...new Set([
    ...(INSTALL_CMDS[testRunnerArgv[0]] || []),
    ...(packageManager ? INSTALL_CMDS[packageManager] || [] : []),
  ])];
  return [
    'Read', 'Edit', 'Write',
    `Bash(${runner})`,
    ...installs,
    'Bash(git diff *)', 'Bash(git status *)', 'Bash(git add *)',
    'Bash(git commit *)', 'Bash(git checkout -b *)', 'Bash(git log *)',
  ].join(',');
}
