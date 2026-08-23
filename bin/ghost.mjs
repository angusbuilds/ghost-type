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
import { planCards, isCodingCard, countUnmergedGhostBranches, listGhostBranches } from '../src/planner.mjs';
import { learn as learnVoice, loadVoice, exemplarsFor } from '../src/voice.mjs';
import { armChecks, arm, disarm, readState, writeState, heartbeatGapMs, reap, reapClone, reconcile, startCaffeinate, stopCaffeinate, writeHeartbeat } from '../src/daemon.mjs';
import { runCardSafely, runProposal, shipCard, shipProposal } from '../src/spine.mjs';
import { runEngine, runAgent } from '../src/engine.mjs';
import { shapeForEngine } from '../src/engine-rules.mjs';
import { verifyCard, patchApplied, classifyClaim, sterileTree } from '../src/verifier.mjs';
import { writeNextPrompt, diagnoseFailure } from '../src/prompt-writer.mjs';
import { generateCandidates, voteBest } from '../src/preflight.mjs';
import { buildSessionEnv, allowedToolsFor } from '../src/env.mjs';
import { makeClone, fetchBranchBack, commitTreeRef } from '../src/clone.mjs';
import { renderReport } from '../src/report.mjs';
import { renderReportHtml } from '../src/report-html.mjs';
import { notifyVerdict } from '../src/notify.mjs';
import { Governor } from '../src/governor.mjs';
import { recordLineage } from '../src/lineage.mjs';
import { selectableSessions } from '../src/sessions.mjs';
import { loadConfig, nightDeadlineMs } from '../src/config.mjs';
import { checkEnv, renderDoctor } from '../src/doctor.mjs';
import { realOnBattery, realFreeDiskGB, realQuarantineBacklog } from '../src/daemon.mjs';
import { haunt, unhaunt, readHaunted } from '../src/haunt.mjs';
import { hauntDrive, defaultDriveDeps } from '../src/drive.mjs';

const CONFIG = loadConfig();   // ~/.ghosttype/config.json merged over safe defaults
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version; } catch { return '0.0.0'; } })();

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
// stderr piped (not inherited) so a caught git failure — e.g. `--no-merged` in an empty repo
// with no HEAD — doesn't leak "fatal:" noise to the console; it's still on the thrown error.
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString();   // 1 MiB default ENOBUFS'd on a large diff (round 22 #5)

function realEngine(card) {
  const env = buildSessionEnv([], process.env, card.engine);   // only this engine's creds (round 5 M9)
  const allowedTools = allowedToolsFor(card.acceptanceArgv || ['true'], card.packageManager);
  // Dispatch by the card's engine. Coding calls get the shaped prompt + full tools; WRITER
  // calls (diagnosis/candidates/vote) get a read-only, tiny-budget model that can't touch
  // the clone (Codex H6) and aren't shaped (they're meta-prompts, not for the coding agent).
  return ({ cwd, prompt, writer, maxBudgetUsd, timeoutMs }) => runAgent({
    engine: card.engine, cwd,
    prompt: writer ? prompt : shapeForEngine(prompt, card.engine, card),
    allowedTools: writer ? 'Read' : allowedTools,      // Claude: read-only tools for writer
    sandbox: writer ? 'read-only' : 'workspace-write', // Codex: read-only sandbox for writer (#1)
    maxTurns: writer ? 1 : card.maxTurns,
    // A per-call governor bound (remaining nightly $) overrides the card's native budget (round 6 #8).
    maxBudgetUsd: maxBudgetUsd ?? (writer ? 1 : card.maxBudgetUsd),
    timeoutMs,                                         // per-call deadline bound; undefined → engine default
    sandboxClone: CONFIG.sandbox ? cwd : undefined,   // OS write-confinement for the coding session (round 8 Critical)
    env,
  });
}

function cardDeps(card, voice) {
  return {
    now: () => Date.now(),
    makeClone,
    headRef: (clonePath) => git(clonePath, 'rev-parse', 'HEAD').trim(),
    patchApplied,
    // Per-iteration patch detection uses the same sterile disk-hash the verifier ships from; a probe
    // failure returns null → the guard reads "changed" and runs verify (never a false fast-park) (round 33).
    treeHashOf: (clonePath) => { try { return sterileTree(clonePath); } catch { return null; } },
    runEngine: realEngine(card),
    commit: (clonePath, branch, { tree, baseRef } = {}) => {
      git(clonePath, 'config', 'user.email', 'ghost@ghosttype.local');
      git(clonePath, 'config', 'user.name', 'Ghost Type');
      const msg = `ghost: ${String(card.goal).slice(0, 60)}`;
      if (tree && baseRef) return commitTreeRef(git, clonePath, branch, tree, baseRef, msg);   // hook-free ship → returns OID (round 13/14)
      try { git(clonePath, 'checkout', '-B', branch); } catch { /* already */ }
      if (git(clonePath, 'status', '--porcelain').trim()) { git(clonePath, 'add', '-A'); git(clonePath, 'commit', '-q', '--no-verify', '-m', msg); }
      return git(clonePath, 'rev-parse', 'HEAD').trim();
    },
    // --no-ext-diff --no-textconv + fsmonitor/hooks off so a planted diff.external/textconv/fsmonitor
    // can't execute in the daemon when we diff the clone on a failed iteration (round 15).
    gitDiff: (cwd) => { const D = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'diff', '--no-ext-diff', '--no-textconv']; return { stat: git(cwd, ...D, '--shortstat', 'HEAD'), excerpt: git(cwd, ...D, 'HEAD').slice(0, 12000) }; },
    // Shared, centralized verifier — acceptance test + deletion guard (round 4 #1 / round 5 H1);
    // acceptance runs in the OS sandbox when configured (round 8: opt-in for untrusted repos).
    verify: (c, clonePath, opts) => verifyCard(c, clonePath, { ...opts, sandbox: CONFIG.sandbox }),
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
      const engine = options.engine || CONFIG.defaultEngine;

      const checks = armChecks();
      if (!checks.ok) {
        console.log('⚠️  arm checks failed:\n  - ' + checks.warnings.join('\n  - '));
        if (!dryRun && !options.force) process.exit(1);
      }

      let dossiers = scanDevRoot(DEV_ROOT);
      if (project) dossiers = dossiers.filter(d => d.name === project);
      // Backpressure: count this project's still-unmerged `ghost/*` branches so overnight
      // supply can't outrun review capacity. Empty {} before meant it NEVER paused (round 4 #7).
      // Count only branches NOT yet merged into HEAD — a ghost/* branch he's already reviewed
      // and merged shouldn't keep consuming the backlog (round 5 M4).
      const unmergedByProject = {};
      const existingBranchesByProject = {};
      for (const d of dossiers) { unmergedByProject[d.name] = countUnmergedGhostBranches(d.repoPath, git); existingBranchesByProject[d.name] = listGhostBranches(d.repoPath, git); }
      const { cards, paused } = planCards({ sendoff: goal, dossiers, dateStr: dateStr(), unmergedByProject, existingBranchesByProject, maxCards: project ? 1 : CONFIG.maxCards, backpressureThreshold: CONFIG.backpressureThreshold, engine });

      console.log(`\n👻 planned queue (${cards.length}):`);
      for (const c of cards) console.log(`  - [${isCodingCard(c) ? 'code' : 'proposal'}] ${c.project}: ${c.goal}`);
      if (paused.length) console.log(`  paused (review backlog): ${paused.join(', ')}`);
      // The clone is built from committed HEAD, so a dirty source's uncommitted work is not included.
      // Surface it rather than refuse (refusing every dirty repo would block actively-developed projects,
      // which is the whole use case) — the ghost's branch is HEAD-based and the morning diff shows it (round 21 #4).
      const dirtyPlanned = [...new Set(dossiers.filter(d => d.dirty).map(d => d.name))].filter(n => cards.some(c => c.project === n));
      if (dirtyPlanned.length) console.log(`  ⚠ uncommitted changes in ${dirtyPlanned.join(', ')} — the ghost builds from HEAD; that WIP is NOT included`);

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
        // arm() re-runs the safety checks; honor a BLOCKED result even though the pre-gate
        // passed — state can change (unplugged, disk filled) in the gap (round 5 M2).
        const armResult = arm({ sendoff: goal, project }); armed = true;
        if (!armResult.checks.ok && !options.force) {
          tripReason = 'arm-time safety check failed';
          console.log('\n⏹ arm-time checks failed — not running:\n  - ' + armResult.checks.warnings.join('\n  - '));
        }
        const runnable = (armResult.checks.ok || options.force);
        const st = readState(); st.queue = cards; writeState(st);
        fs.mkdirSync(REPORT_DIR, { recursive: true });
        // Preserve orphaned clones from a crashed prior night (unfinished, never branched back)
        // by adding them to the keep-list — reaping them would silently destroy that work (round 5 H2).
        const orphans = reconcile({ activeBranches: cards.map(c => c.branch) });
        if (orphans.length) console.log(`  ↩ preserving ${orphans.length} orphaned clone(s) from a prior run: ${orphans.join(', ')}`);
        reap({ keep: [...cards.map(c => c.branch.replace(/[^\w.-]/g, '_')), ...orphans] });
        caff = startCaffeinate();
        writeHeartbeat();
        hb = setInterval(() => writeHeartbeat(), 120_000);
        // Ctrl-C stops gracefully after the current card so `finally` still disarms + reports;
        // a second Ctrl-C hard-exits (recovered by reconcile on the next arm).
        let interrupted = false;
        process.on('SIGINT', () => {
          // A second Ctrl-C force-exits, but still run the critical cleanup first — otherwise the
          // caffeinate process survives (machine never sleeps) and the armed state is left stale
          // (round 31 night audit #2). reconcile recovers any half-done clone on the next arm.
          if (interrupted) { try { if (hb) clearInterval(hb); stopCaffeinate(caff); if (armed) disarm(); } catch { /* best effort */ } process.exit(130); }
          interrupted = true; console.log('\n⏹ interrupt — finishing this card, then stopping (Ctrl-C again to force)…');
        });
        for (const card of (runnable ? cards.filter(isCodingCard) : [])) {
          if (interrupted) { tripReason = 'interrupted'; break; }
          const pre = gov.check(Date.now());
          if (!pre.ok) { tripReason = pre.trip; console.log(`\n⏹ stopping: ${pre.trip}`); break; }
          console.log(`\n▶ ${card.project}: ${card.goal}`);
          const deps = cardDeps(card, voice);
          deps.governor = gov;                              // meters every engine call (H5)
          const lineageFile = path.join(REPORT_DIR, `lineage-${card.project}.jsonl`);
          deps.recordPrompt = (e) => recordLineage(lineageFile, { ...e, ts: new Date().toISOString() });
          const r = await runCardSafely(card, deps);        // per-card boundary: a throw parks, never aborts the night (round 18 #10)
          const wasMergeReady = r.mergeReady;
          // Fetch the verified branch back + reap the clone (or park on fetch-fail, preserve on ignored
          // state) — the exact round-18/19/20 logic, now the tested shipCard() (round 31 dedupe).
          shipCard(card, r, { fetchBranchBack, reapClone, workDir: WORK_DIR });
          if (wasMergeReady && !r.mergeReady) console.error('⚠', r.whyLine);
          else if (r.mergeReady && r.hadIgnoredState) console.log(`  ↩ preserving ${card.branch.replace(/[^\w.-]/g, '_')}: had git-ignored state before acceptance (not in the shipped tree)`);
          results.push(r);
          const post = gov.check(Date.now());
          if (!post.ok) { tripReason = post.trip; console.log(`\n⏹ stopping: ${post.trip}`); break; }
        }
        // Proposal cards can't be graded unattended (no runner), but instead of being dropped they have
        // the agent WRITE a plan (PLAN.md on the branch) the owner reviews in the morning (round 28 #13).
        for (const c of (runnable ? cards.filter(c => !isCodingCard(c)) : [])) {   // arm-time failure stops proposals too, not just coding cards (round 31 night audit #1)
          const gc = gov.check(Date.now());   // check ONCE (was called twice), and record the trip so the report shows why (round 29)
          if (interrupted || !gc.ok) {
            if (!gc.ok && !tripReason) tripReason = gc.trip;
            results.push({ project: c.project, goal: c.goal, outcome: 'skipped', mergeReady: false, whyLine: 'not started — ' + (interrupted ? 'interrupted' : (gc.trip || 'stopped')), branch: c.branch, iterations: 0, promptsWritten: [], testOutput: '' });
            continue;
          }
          console.log(`\n📝 ${c.project}: proposing a plan for "${c.goal}"`);
          const deps = cardDeps(c, voice); deps.governor = gov;
          deps.writePlan = (cp, content) => fs.writeFileSync(path.join(cp, 'PLAN.md'), content);
          const r = await runProposal(c, deps);
          // Fetch the PLAN.md commit back + reap (or park+preserve on fetch-fail) — tested shipProposal (round 31).
          shipProposal(c, r, { fetchBranchBack, reapClone, workDir: WORK_DIR });
          results.push(r);
          const post = gov.check(Date.now());   // a trip on the LAST proposal must still reach the report (round 31 night audit #4)
          if (!post.ok && !tripReason) tripReason = post.trip;
        }
      } finally {
        if (hb) clearInterval(hb);
        stopCaffeinate(caff);
        if (armed) disarm();                                // guaranteed if we armed — never skipped
        // Report the GOVERNOR's running cost, not the sum of completed cards — a card that
        // threw after an engine call was metered would otherwise drop its cost from the report,
        // hiding real spend (round 6 #10). gov.costUsd includes every metered call.
        const night = { date: dateStr(), cards: results, tokens: gov.tokens, costUsd: gov.costUsd, tripReason };
        // Notify FIRST and on its OWN try — the failure notification is exactly the case
        // where visibility matters most, so a render/disk error must not swallow it (round 4 #10).
        try { notifyVerdict(night); } catch (e) { console.error('notify error:', e.message); }
        try {
          const md = renderReport(night);
          fs.writeFileSync(path.join(REPORT_DIR, 'latest.md'), md);
          fs.writeFileSync(path.join(REPORT_DIR, 'latest.html'), renderReportHtml(night));
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
    case 'haunt': { const id = rest[0]; if (!id) throw new UsageError('ghost haunt <pane-id>'); haunt(id); console.log(`🟣 haunting ${id}`); break; }
    case 'unhaunt': { const id = rest[0]; if (!id) throw new UsageError('ghost unhaunt <pane-id>'); unhaunt(id); console.log(`released ${id}`); break; }
    case 'haunts': { const list = readHaunted(); console.log(list.length ? 'haunting: ' + list.join(', ') : 'not haunting any panes'); break; }
    case 'drive': {
      const { options, positionals } = parseArgs(rest, ['--engine', '--max'], []);
      const paneId = positionals[0];
      const goal = positionals.slice(1).join(' ');
      if (!paneId || !goal) throw new UsageError('ghost drive <pane-id> "<goal>"');
      if (options.engine !== undefined && !['claude', 'codex'].includes(options.engine)) throw new UsageError('--engine must be claude or codex');
      const engine = options.engine || CONFIG.defaultEngine;
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
      const result = checkEnv({ has, claudeVersion, onBattery: realOnBattery, freeDiskGB: realFreeDiskGB, dcgPresent, quarantine: realQuarantineBacklog });
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
    default: {
      const help = ['ghost — keep coding agents working while you are away\n',
        '  ghost scan [devRoot]                 list projects + test runners',
        '  ghost learn                          build your voice profile',
        '  ghost on "<goal>" [--project P] [--dry-run]   arm + run tonight',
        '  ghost sessions | haunt <pane> | unhaunt <pane> | drive <pane> "<goal>"',
        '  ghost doctor                         check the environment is ready',
        '  ghost off | status | queue | report | logs [N]'].join('\n');
      // Bare `ghost` is a help request (exit 0); an actual unknown command is a usage
      // error (exit 2) so scripts can tell a typo from success (round 4 #12).
      if (cmd === undefined || cmd === '--help' || cmd === '-h') { console.log(help); break; }
      if (cmd === '--version' || cmd === '-v') { console.log(VERSION); break; }
      throw new UsageError(`unknown command "${cmd}"\n${help}`);
    }
  }
}

main().catch(e => {
  if (e instanceof UsageError) { console.error(`usage: ${e.message}`); process.exit(2); }
  console.error('ghost error:', e.message); process.exit(1);
});
