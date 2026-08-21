// src/doctor.mjs
// Environment self-check — what a real deployment needs verified before it trusts an
// unattended night. Pure logic (the probes are injected) so it's testable offline.
export function checkEnv({ has, claudeVersion, onBattery, freeDiskGB, dcgPresent } = {}) {
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
