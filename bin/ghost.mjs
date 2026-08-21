#!/usr/bin/env node
// ghost — the Ghost Type CLI.
//   ghost scan [devRoot]            list projects + detected test runners
//   ghost learn                     build your voice profile from ~/.claude transcripts
//   ghost on "<goal>" [--project P] [--dry-run]   arm and run tonight's queue
//   ghost off                       disarm
//   ghost status                    show state + heartbeat
//   ghost queue                     show tonight's planned cards
//   ghost report                    print the latest morning report
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WORK_DIR, STATE_DIR, CLAUDE_BIN, LOG_FILE, ensureState } from '../src/lib.mjs';
import { scanDevRoot } from '../src/dossier.mjs';
import { planCards, isCodingCard } from '../src/planner.mjs';
import { learn as learnVoice, loadVoice, exemplarsFor } from '../src/voice.mjs';
import { armChecks, arm, disarm, readState, writeState, heartbeatGapMs, reap, reconcile, startCaffeinate, stopCaffeinate, writeHeartbeat } from '../src/daemon.mjs';
import { runCard } from '../src/spine.mjs';
import { runEngine, runAgent } from '../src/engine.mjs';
import { shapeForEngine } from '../src/engine-rules.mjs';
import { runAcceptance, patchApplied, classifyClaim, suspiciousDeletion } from '../src/verifier.mjs';
import { writeNextPrompt, diagnoseFailure } from '../src/prompt-writer.mjs';
import { generateCandidates, voteBest } from '../src/preflight.mjs';
import { buildSessionEnv, allowedToolsFor } from '../src/env.mjs';
import { makeClone, fetchBranchBack } from '../src/clone.mjs';
import { renderReport } from '../src/report.mjs';
import { renderReportHtml } from '../src/report-html.mjs';
import { notifyVerdict } from '../src/notify.mjs';
import { Governor } from '../src/governor.mjs';
import { recordLineage } from '../src/lineage.mjs';
import { selectableSessions } from '../src/sessions.mjs';
import { loadConfig, nightDeadlineMs } from '../src/config.mjs';
import { checkEnv, renderDoctor } from '../src/doctor.mjs';
import { realOnBattery, realFreeDiskGB } from '../src/daemon.mjs';
import { haunt, unhaunt, readHaunted } from '../src/haunt.mjs';
import { hauntDrive, defaultDriveDeps } from '../src/drive.mjs';

const CONFIG = loadConfig();   // ~/.ghosttype/config.json merged over safe defaults

const HOME = os.homedir();
const DEV_ROOT = path.join(HOME, 'dev');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const REPORT_DIR = path.join(HOME, 'dev', 'pages', 'ghost-type');
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? (rest[i + 1] ?? true) : undefined; };
const has = (name) => rest.includes(name);

// Explicit, FAIL-CLOSED option parsing (Codex re-audit #3): a value-flag must be followed
// by a real value (not another flag, not the end); unknown flags are rejected. Throws a
// UsageError the caller turns into a usage message + exit 2 — never silently mis-parses.
class UsageError extends Error {}
function parseArgs(argv, valueFlags = [], boolFlags = []) {
  const options = {}; const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      options[a.replace(/^--/, '')] = v; i++;
    } else if (boolFlags.includes(a)) options[a.replace(/^--/, '')] = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else positionals.push(a);
  }
  return { options, positionals };
}
const dateStr = () => new Date().toISOString().slice(0, 10);
const git = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();

function realEngine(card) {
  const env = buildSessionEnv();
  const allowedTools = allowedToolsFor(card.acceptanceArgv || ['true']);
  // Dispatch by the card's engine. Coding calls get the shaped prompt + full tools; WRITER
  // calls (diagnosis/candidates/vote) get a read-only, tiny-budget model that can't touch
  // the clone (Codex H6) and aren't shaped (they're meta-prompts, not for the coding agent).
  return ({ cwd, prompt, writer }) => runAgent({
    engine: card.engine, cwd,
    prompt: writer ? prompt : shapeForEngine(prompt, card.engine, card),
    allowedTools: writer ? 'Read' : allowedTools,      // Claude: read-only tools for writer
    sandbox: writer ? 'read-only' : 'workspace-write', // Codex: read-only sandbox for writer (#1)
    maxTurns: writer ? 1 : card.maxTurns,
    maxBudgetUsd: writer ? 1 : card.maxBudgetUsd,
    env,
  });
}

function cardDeps(card, voice) {
  return {
    now: () => Date.now(),
    makeClone,
    headRef: (clonePath) => git(clonePath, 'rev-parse', 'HEAD').trim(),
    patchApplied,
    runEngine: realEngine(card),
    commit: (clonePath, branch) => {
      git(clonePath, 'config', 'user.email', 'ghost@ghosttype.local');
      git(clonePath, 'config', 'user.name', 'Ghost Type');
      try { git(clonePath, 'checkout', '-B', branch); } catch { /* already */ }
      if (git(clonePath, 'status', '--porcelain').trim()) { git(clonePath, 'add', '-A'); git(clonePath, 'commit', '-q', '-m', `ghost: ${String(card.goal).slice(0, 60)}`); }
    },
    gitDiff: (cwd) => ({ stat: git(cwd, 'diff', '--shortstat', 'HEAD'), excerpt: git(cwd, 'diff', 'HEAD').slice(0, 12000) }),
    verify: async (c, clonePath) => {
      const r = await runAcceptance(c.acceptanceArgv, clonePath, c.acceptanceTimeoutSec);
      if (!r.pass) return { pass: false, detail: { testOutput: r.stderrHead } };
      // Test passed — but did it "pass" by deleting the feature? (the overnight classic)
      const stat = git(clonePath, 'diff', '--shortstat', 'HEAD').trim();
      if (suspiciousDeletion(c.goal, stat)) {
        return { pass: false, detail: { testOutput: `test passed but the diff is net-negative for a build goal — refusing (${stat})` } };
      }
      return { pass: true, detail: { testOutput: 'acceptance passed (exit 0)' } };
    },
    classifyClaim, diagnoseFailure, generateCandidates, voteBest, writeNextPrompt,
    voiceProfile: voice.profile,
    exemplars: exemplarsFor(voice.bank, card.situation || 'kickoff'),
    sleepUntil: (ms) => new Promise(res => setTimeout(res, Math.min(Math.max(ms - Date.now(), 0), 3600_000))),
  };
}

async function main() {
  ensureState();
  switch (cmd) {
    case 'scan': {
      const root = rest[0] && !rest[0].startsWith('--') ? rest[0] : DEV_ROOT;
      const dossiers = scanDevRoot(root);
      console.log(`\nProjects under ${root}:\n`);
      for (const d of dossiers) {
        const runner = d.testRunner ? d.testRunner.join(' ') : '— (proposal-only)';
        console.log(`  ${d.canRunUnattended ? '✅' : '○'} ${d.name.padEnd(20)} ${runner.padEnd(18)} ${d.lastCommit}`);
      }
      console.log(`\n${dossiers.filter(d => d.canRunUnattended).length}/${dossiers.length} can run unattended.\n`);
      break;
    }
    case 'learn': {
      console.log('👻 learning your voice from ~/.claude transcripts…');
      const engine = ({ prompt }) => runEngine({ cwd: HOME, prompt, allowedTools: 'Read', maxTurns: 1, maxBudgetUsd: 1, env: buildSessionEnv(), bin: CLAUDE_BIN });
      const res = await learnVoice({ projectsDir: PROJECTS_DIR, engine });
      console.log(`  ${res.totalPrompts} prompts found, ${res.sampled} sampled.`);
      console.log(`  profile → ${res.profilePath}`);
      console.log(`  exemplars → ${res.exemplarPath}`);
      break;
    }
    case 'on': {
      const { options, positionals } = parseArgs(rest, ['--project', '--engine'], ['--dry-run', '--force']);
      const goal = positionals.join(' ').trim() || null;
      const project = options.project;
      const dryRun = Boolean(options['dry-run']);
      if (options.engine !== undefined && !['claude', 'codex'].includes(options.engine)) throw new UsageError('--engine must be claude or codex');
      const engine = options.engine || 'claude';

      const checks = armChecks();
      if (!checks.ok) {
        console.log('⚠️  arm checks failed:\n  - ' + checks.warnings.join('\n  - '));
        if (!dryRun && !options.force) process.exit(1);
      }

      let dossiers = scanDevRoot(DEV_ROOT);
      if (project) dossiers = dossiers.filter(d => d.name === project);
      const { cards, paused } = planCards({ sendoff: goal, dossiers, dateStr: dateStr(), maxCards: project ? 1 : CONFIG.maxCards, backpressureThreshold: CONFIG.backpressureThreshold, engine });

      console.log(`\n👻 planned queue (${cards.length}):`);
      for (const c of cards) console.log(`  - [${isCodingCard(c) ? 'code' : 'proposal'}] ${c.project}: ${c.goal}`);
      if (paused.length) console.log(`  paused (review backlog): ${paused.join(', ')}`);

      // M3: dry-run touches NO persistent state — return before arming or writing the queue.
      if (dryRun) { console.log('\n(dry-run — planned only, nothing armed or executed)\n'); break; }

      // H9 + re-audit round 3: arming itself is INSIDE the try, so even a failure writing
      // the queue can't leave the state armed without reaching disarm.
      const voice = loadVoice();
      const gov = new Governor({ maxTokensNight: CONFIG.maxTokensNight, maxCostUsd: CONFIG.maxCostUsd, nightDeadlineMs: nightDeadlineMs(CONFIG), maxConsecErrors: CONFIG.maxConsecErrors });
      const results = [];
      let tripReason = null;
      let caff = null, hb = null, armed = false;
      try {
        arm({ sendoff: goal, project }); armed = true;
        const st = readState(); st.queue = cards; writeState(st);
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        reconcile({ activeBranches: cards.map(c => c.branch) });
        reap({ keep: cards.map(c => c.branch.replace(/[^\w.-]/g, '_')) });
        caff = startCaffeinate();
        writeHeartbeat();
        hb = setInterval(() => writeHeartbeat(), 120_000);
        // Ctrl-C stops gracefully after the current card so `finally` still disarms + reports;
        // a second Ctrl-C hard-exits (recovered by reconcile on the next arm).
        let interrupted = false;
        process.on('SIGINT', () => {
          if (interrupted) process.exit(130);
          interrupted = true; console.log('\n⏹ interrupt — finishing this card, then stopping (Ctrl-C again to force)…');
        });
        for (const card of cards.filter(isCodingCard)) {
          if (interrupted) { tripReason = 'interrupted'; break; }
          const pre = gov.check(Date.now());
          if (!pre.ok) { tripReason = pre.trip; console.log(`\n⏹ stopping: ${pre.trip}`); break; }
          console.log(`\n▶ ${card.project}: ${card.goal}`);
          const deps = cardDeps(card, voice);
          deps.governor = gov;                              // meters every engine call (H5)
          const lineageFile = path.join(REPORT_DIR, `lineage-${card.project}.jsonl`);
          deps.recordPrompt = (e) => recordLineage(lineageFile, { ...e, ts: new Date().toISOString() });
          const r = await runCard(card, deps);
          if (r.mergeReady) fetchBranchBack(card.repoPath, path.join(WORK_DIR, card.branch.replace(/[^\w.-]/g, '_')), card.branch);
          results.push(r);
          const post = gov.check(Date.now());
          if (!post.ok) { tripReason = post.trip; console.log(`\n⏹ stopping: ${post.trip}`); break; }
        }
      } finally {
        if (hb) clearInterval(hb);
        stopCaffeinate(caff);
        if (armed) disarm();                                // guaranteed if we armed — never skipped
        try {
          const night = { date: dateStr(), cards: results, tokens: gov.tokens, costUsd: results.reduce((n, r) => n + (r.costUsd || 0), 0), tripReason };
          const md = renderReport(night);
          fs.writeFileSync(path.join(REPORT_DIR, 'latest.md'), md);
          fs.writeFileSync(path.join(REPORT_DIR, 'latest.html'), renderReportHtml(night));
          notifyVerdict(night);
          try { execFileSync('open', [path.join(REPORT_DIR, 'latest.html')]); } catch { /* headless */ }
          console.log('\n' + md + `\n\nreport → ${path.join(REPORT_DIR, 'latest.html')}`);
        } catch (e) { console.error('report error:', e.message); }
      }
      break;
    }
    case 'sessions': {
      const list = selectableSessions();
      if (has('--json')) { console.log(JSON.stringify(list)); break; }   // for the menu-bar picker
      if (!list.length) { console.log('no tmux sessions found (is tmux running?)'); break; }
      console.log('\nSelectable sessions (agents first):\n');
      list.forEach((s, i) => console.log(`  ${String(i).padStart(2)}  ${s.target.padEnd(14)} ${s.cmd.padEnd(10)} ${s.title}`));
      console.log('\nPick one to haunt from the menu bar, or: ghost haunt <target>\n');
      break;
    }
    case 'haunt': { const id = rest[0]; if (!id) { console.log('usage: ghost haunt <pane-id>'); break; } haunt(id); console.log(`🟣 haunting ${id}`); break; }
    case 'unhaunt': { const id = rest[0]; if (!id) { console.log('usage: ghost unhaunt <pane-id>'); break; } unhaunt(id); console.log(`released ${id}`); break; }
    case 'haunts': { const list = readHaunted(); console.log(list.length ? 'haunting: ' + list.join(', ') : 'not haunting any panes'); break; }
    case 'drive': {
      const { options, positionals } = parseArgs(rest, ['--engine', '--max'], []);
      const paneId = positionals[0];
      const goal = positionals.slice(1).join(' ');
      if (!paneId || !goal) { console.log('usage: ghost drive <pane-id> "<goal>"'); break; }
      if (options.engine !== undefined && !['claude', 'codex'].includes(options.engine)) throw new UsageError('--engine must be claude or codex');
      const engine = options.engine || 'claude';
      let maxInjects = 20;
      if (options.max !== undefined) {
        const m = Number(options.max);
        if (!Number.isInteger(m) || m <= 0) throw new UsageError('--max must be a positive integer');
        maxInjects = m;
      }
      haunt(paneId);   // tint it purple while we drive
      // M5: always release the tint/state — on normal return, exception, or Ctrl-C.
      const cleanup = () => { try { unhaunt(paneId); } catch { /* pane gone */ } };
      process.once('SIGINT', () => { cleanup(); process.exit(130); });
      console.log(`🟣 driving ${paneId} toward: ${goal}  (ctrl-c to stop)`);
      try {
        const driveDeps = { ...defaultDriveDeps({ engine }), humanThreshold: CONFIG.humanIdleThreshold };
        const out = await hauntDrive({ paneId, goal, deps: driveDeps, maxInjects, pollMs: CONFIG.pollMs, minStable: CONFIG.minStable });
        console.log(`\ndone: ${out.reason} · ${out.injects} prompt(s) injected`);
      } finally { cleanup(); }
      break;
    }
    case 'doctor': {
      const has = (bin) => { try { execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };
      let claudeVersion = ''; try { claudeVersion = execFileSync(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().match(/[\d.]+/)?.[0] || ''; } catch { /* absent */ }
      const dcgPresent = has('dcg') || fs.existsSync(`${HOME}/.claude/hooks/guard.py`);
      const result = checkEnv({ has, claudeVersion, onBattery: realOnBattery, freeDiskGB: realFreeDiskGB, dcgPresent });
      console.log('\n👻 Ghost Type — environment check\n');
      console.log(renderDoctor(result));
      console.log('');
      process.exit(result.fatalFail ? 1 : 0);
    }
    case 'logs': {
      const n = Number(rest[0]) > 0 ? Number(rest[0]) : 20;
      let lines = [];
      try { lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean); } catch { /* none yet */ }
      const recent = lines.slice(-n).map(l => {
        try { const j = JSON.parse(l); return `  ${(j.t || '').slice(11, 19)}  ${(j.evt || '').padEnd(16)} ${j.project || ''}${j.why ? ' — ' + j.why : ''}${j.trip ? ' (' + j.trip + ')' : ''}`; }
        catch { return '  ' + l; }
      });
      console.log(recent.length ? recent.join('\n') : 'no events logged yet.');
      break;
    }
    case 'off': { disarm(); console.log('👻 disarmed.'); break; }
    case 'status': {
      const st = readState();
      const gap = heartbeatGapMs();
      console.log(`status: ${st.status}`);
      if (st.sendoff) console.log(`sendoff: ${st.sendoff}`);
      console.log(`queue: ${(st.queue || []).length} card(s)`);
      console.log(`heartbeat: ${gap === Infinity ? 'none' : Math.round(gap / 1000) + 's ago'}`);
      break;
    }
    case 'queue': {
      const st = readState();
      for (const c of st.queue || []) console.log(`  - [${isCodingCard(c) ? 'code' : 'proposal'}] ${c.project}: ${c.goal}`);
      if (!(st.queue || []).length) console.log('  (empty)');
      break;
    }
    case 'report': {
      const p = path.join(REPORT_DIR, 'latest.md');
      console.log(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 'no report yet — run `ghost on` first.');
      break;
    }
    default:
      console.log('ghost — keep coding agents working while you are away\n');
      console.log('  ghost scan [devRoot]                 list projects + test runners');
      console.log('  ghost learn                          build your voice profile');
      console.log('  ghost on "<goal>" [--project P] [--dry-run]   arm + run tonight');
      console.log('  ghost sessions | haunt <pane> | unhaunt <pane> | drive <pane> "<goal>"');
      console.log('  ghost doctor                         check the environment is ready');
      console.log('  ghost off | status | queue | report | logs [N]');
  }
}

main().catch(e => {
  if (e instanceof UsageError) { console.error(`usage: ${e.message}`); process.exit(2); }
  console.error('ghost error:', e.message); process.exit(1);
});
