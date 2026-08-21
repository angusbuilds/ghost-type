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
import { WORK_DIR, STATE_DIR, CLAUDE_BIN, ensureState } from '../src/lib.mjs';
import { scanDevRoot } from '../src/dossier.mjs';
import { planCards, isCodingCard } from '../src/planner.mjs';
import { learn as learnVoice, loadVoice, exemplarsFor } from '../src/voice.mjs';
import { armChecks, arm, disarm, readState, writeState, heartbeatGapMs, reap } from '../src/daemon.mjs';
import { runCard } from '../src/spine.mjs';
import { runEngine } from '../src/engine.mjs';
import { runAcceptance, patchApplied, classifyClaim } from '../src/verifier.mjs';
import { writeNextPrompt, diagnoseFailure } from '../src/prompt-writer.mjs';
import { generateCandidates, voteBest } from '../src/preflight.mjs';
import { buildSessionEnv, allowedToolsFor } from '../src/env.mjs';
import { makeClone, fetchBranchBack } from '../src/clone.mjs';
import { renderReport } from '../src/report.mjs';
import { renderReportHtml } from '../src/report-html.mjs';
import { notifyVerdict } from '../src/notify.mjs';

const HOME = os.homedir();
const DEV_ROOT = path.join(HOME, 'dev');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const REPORT_DIR = path.join(HOME, 'dev', 'pages', 'ghost-type');
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? (rest[i + 1] ?? true) : undefined; };
const has = (name) => rest.includes(name);
const dateStr = () => new Date().toISOString().slice(0, 10);
const git = (cwd, ...a) => execFileSync('git', a, { cwd }).toString();

function realEngine(card) {
  const env = buildSessionEnv();
  const allowedTools = allowedToolsFor(card.acceptanceArgv || ['true']);
  return ({ cwd, prompt }) => runEngine({ cwd, prompt, allowedTools, maxTurns: card.maxTurns, maxBudgetUsd: card.maxBudgetUsd, env });
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
      return { pass: r.pass, detail: { testOutput: r.pass ? 'acceptance passed (exit 0)' : r.stderrHead } };
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
      const goal = rest.find(a => !a.startsWith('--') && a !== flag('--project'));
      const project = flag('--project');
      const dryRun = has('--dry-run');
      const checks = armChecks();
      if (!checks.ok) {
        console.log('⚠️  arm checks failed:\n  - ' + checks.warnings.join('\n  - '));
        if (!dryRun && !has('--force')) process.exit(1);  // dry-run may still plan
      }

      let dossiers = scanDevRoot(DEV_ROOT);
      if (project) dossiers = dossiers.filter(d => d.name === project);
      const { cards, paused } = planCards({ sendoff: goal, dossiers, dateStr: dateStr(), maxCards: project ? 1 : 2 });
      arm({ sendoff: goal, project });
      const st = readState(); st.queue = cards; writeState(st);

      console.log(`\n👻 armed. queue (${cards.length}):`);
      for (const c of cards) console.log(`  - [${isCodingCard(c) ? 'code' : 'proposal'}] ${c.project}: ${c.goal}`);
      if (paused.length) console.log(`  paused (review backlog): ${paused.join(', ')}`);
      if (dryRun) { console.log('\n(dry-run — planned only, nothing executed)\n'); break; }

      const voice = loadVoice();
      const results = [];
      for (const card of cards.filter(isCodingCard)) {
        console.log(`\n▶ ${card.project}: ${card.goal}`);
        const r = await runCard(card, cardDeps(card, voice));
        if (r.mergeReady) fetchBranchBack(card.repoPath, path.join(WORK_DIR, card.branch.replace(/[^\w.-]/g, '_')), card.branch);
        results.push(r);
      }
      const night = { date: dateStr(), cards: results, tokens: 0, costUsd: 0 };
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const md = renderReport(night);
      fs.writeFileSync(path.join(REPORT_DIR, 'latest.md'), md);
      fs.writeFileSync(path.join(REPORT_DIR, 'latest.html'), renderReportHtml(night));
      disarm();
      notifyVerdict(night);                                 // push, never silent
      try { execFileSync('open', [path.join(REPORT_DIR, 'latest.html')]); } catch { /* headless */ }
      console.log('\n' + md);
      console.log(`\nreport → ${path.join(REPORT_DIR, 'latest.html')}`);
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
      console.log('  ghost off | status | queue | report');
  }
}

main().catch(e => { console.error('ghost error:', e.message); process.exit(1); });
