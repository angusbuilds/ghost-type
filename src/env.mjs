// src/env.mjs

// Pass-through vars a coding session legitimately needs. Everything else is dropped
// unless the card explicitly re-admits it via extraAllow.
const BASE_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NODE_ENV',
]);

export function buildSessionEnv(extraAllow = [], src = process.env) {
  const allow = new Set([...BASE_ALLOW, ...extraAllow]);
  const out = {};
  for (const [k, v] of Object.entries(src)) if (allow.has(k)) out[k] = v;
  out.GHOST_SESSION = '1';
  return out;
}

// Build the --allowedTools value: reads/edits/writes, the exact test runner as a
// Bash command, and git plumbing that can never push. No gh/curl/deploy.
export function allowedToolsFor(testRunnerArgv) {
  const runner = testRunnerArgv.join(' ');
  return [
    'Read', 'Edit', 'Write',
    `Bash(${runner})`,
    'Bash(git diff *)', 'Bash(git status *)', 'Bash(git add *)',
    'Bash(git commit *)', 'Bash(git checkout -b *)', 'Bash(git log *)',
  ].join(',');
}
