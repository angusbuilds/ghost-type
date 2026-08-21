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
    `  (subpath "${home}/.claude") (subpath "${home}/.codex") (subpath "${home}/.cache") (subpath "${home}/.npm")`,   // agent/tool state
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))',
  ].join(' ');
  return ['sandbox-exec', '-p', profile, ...argv];
}
