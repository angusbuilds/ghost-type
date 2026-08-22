// src/doctor.mjs
// Environment self-check — what a real deployment needs verified before it trusts an
// unattended night. Pure logic (the probes are injected) so it's testable offline.
export function checkEnv({ has, claudeVersion, onBattery, freeDiskGB, dcgPresent, quarantine } = {}) {
  const checks = [];
  const req = (name, ok, detail, fatal = false) => checks.push({ name, ok: Boolean(ok), detail, fatal });

  req('node', has('node'), 'the runtime', true);
  req('git', has('git'), 'clones + branches', true);
  req('claude CLI', has('claude'), claudeVersion ? `v${claudeVersion}` : 'the default engine', true);
  req('codex CLI', has('codex'), 'the second engine (optional)', false);
  req('tmux', has('tmux'), 'haunt mode (optional)', false);
  req('dcg guard', dcgPresent, 'the PreToolUse safety net', false);

  const gb = freeDiskGB();
  req('disk', gb >= 20, `${gb === Infinity ? '∞' : gb}GB free (need ≥20)`, false);
  // Sample power ONCE and require an explicit `false` (on AC) — an unknown/null probe must not
  // read as "plugged in" via `!null`, matching what armChecks actually enforces (round 6 #11).
  const battery = onBattery();
  req('AC power', battery === false,
    battery === false ? 'plugged in' : battery === true ? 'on battery — the machine will sleep' : 'power state unreadable', false);

  // Crashed clones are quarantined and preserved forever (round 7 High#2 — never auto-delete
  // possibly-only-copy work), so a backlog is invisible until it eats the 20GB disk floor and
  // silently blocks arming. Surface it here (advisory, never fatal) so the owner clears reviewed
  // ones. Only added when a probe is injected — absent probe leaves the check set untouched.
  if (quarantine) {
    const q = quarantine();
    const detail = q == null
      ? 'could not read the work dir'
      : q.count === 0
        ? 'no crashed clones held'
        : `${q.count} crashed clone${q.count === 1 ? '' : 's'} preserved${q.sizeMB != null ? ` (~${q.sizeMB}MB)` : ''} — review, then clear to reclaim disk`;
    req('quarantine', q != null && q.count === 0, detail, false);
  }

  const fatalFail = checks.some(c => c.fatal && !c.ok);
  const ready = checks.every(c => c.ok || !c.fatal);
  return { checks, ready, fatalFail, armable: !fatalFail && battery === false && gb >= 20 };
}

export function renderDoctor(result) {
  const lines = result.checks.map(c =>
    `  ${c.ok ? '✅' : (c.fatal ? '❌' : '○')} ${c.name.padEnd(12)} ${c.detail}`
  );
  const verdict = result.fatalFail
    ? '\n❌ not usable — a required tool is missing.'
    : result.armable
      ? '\n✅ ready to arm an unattended night.'
      : '\n○ usable, but not armable right now (see AC power / disk above).';
  return lines.join('\n') + '\n' + verdict;
}
