// src/sandbox.mjs
// Optional macOS OS-level sandboxing (sandbox-exec / SBPL) for running agent-influenced code.
// Two profiles for two different jobs; both no-op off macOS. Enabled by the `sandbox` config flag
// (default off) because these jails intentionally break some legitimate work — they're for
// pointing Ghost Type at UNTRUSTED repositories (round 8 hardening).
import os from 'node:os';

// ACCEPTANCE test: the command is project code the agent may have modified, and it needs no
// network — so DENY network (the exfiltration path) and deny writes to the obvious credential
// stores. (A network-denied jail breaks test suites that reach the network — hence opt-in.)
export function sandboxNetDeny(argv, { home = os.homedir(), platform = process.platform } = {}) {
  if (platform !== 'darwin') return argv;
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    `(deny file-write* (subpath "${home}/.ssh") (subpath "${home}/.aws") (subpath "${home}/.gnupg") (subpath "${home}/.config"))`,
  ].join(' ');
  return ['sandbox-exec', '-p', profile, ...argv];
}

// CODING session: the agent needs the network (its provider API) but should only WRITE inside
// the clone (+ its own state/tmp). This blocks the agent editing files elsewhere on the host
// (~/.zshrc, ~/.ssh, system files) — the confinement the bare Read/Edit/Write grants lacked.
export function sandboxWriteConfine(argv, clone, { home = os.homedir(), platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  if (platform !== 'darwin' || !clone) return argv;
  const profile = [
    '(version 1)',
    '(allow default)',                 // network stays up — the agent's API needs it
    '(deny file-write*)',
    '(allow file-write*',
    `  (subpath "${clone}") (subpath "/private${clone}")`,   // the clone (both real + /private alias)
    `  (subpath "${tmpdir}") (regex #"^/private/var/folders/")`,
    // agent/tool state + package-manager stores/caches, so the agent can bootstrap the clone's missing
    // deps under the sandbox too (npm/pnpm/yarn/bun write outside the clone) — round 28 #12b under sandbox.
    `  (subpath "${home}/.claude") (subpath "${home}/.codex") (subpath "${home}/.cache") (subpath "${home}/.npm")`,
    `  (subpath "${home}/.bun") (subpath "${home}/.local") (subpath "${home}/Library/pnpm") (subpath "${home}/Library/Caches")`,
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))',
    // Re-DENY the dangerous paths INSIDE those broad allows (seatbelt = last match wins): the agent
    // BINARIES and the hooks/settings/config that run on the NEXT session. Without this, a "confined"
    // untrusted-repo session could rewrite the tooling that executes it — overwrite ~/.local/bin/claude|
    // codex, drop a hook into ~/.claude/hooks (which holds the dcg/guard safety hooks), or edit
    // settings.json / ~/.codex/config.toml — a sandbox escape. The allows above keep dep-bootstrap caches
    // writable (round 32 parallel-audit CRITICAL; the broad allows were round 28 #12b).
    '(deny file-write*',
    `  (subpath "${home}/.local/bin")`,
    `  (subpath "${home}/.claude/hooks") (subpath "${home}/.claude/commands") (subpath "${home}/.claude/agents")`,
    `  (literal "${home}/.claude/settings.json") (literal "${home}/.claude/settings.local.json") (literal "${home}/.claude/CLAUDE.md")`,
    `  (subpath "${home}/.codex/hooks") (literal "${home}/.codex/config.toml") (literal "${home}/.codex/AGENTS.md"))`,
  ].join(' ');
  return ['sandbox-exec', '-p', profile, ...argv];
}
