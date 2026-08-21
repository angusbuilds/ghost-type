// src/ledger.mjs
import { byteCap } from './lib.mjs';

// A literal, in-context record of every prompt tried for one card and how it went,
// so the Prompt Writer sees the whole trend rather than just the last attempt.
export class Ledger {
  constructor() { this.rows = []; }

  record({ iteration, prompt, outcome, exitCode, stderrHead, howClose }) {
    this.rows.push({
      iteration,
      prompt: byteCap(String(prompt || ''), 200),
      outcome: outcome || 'unknown',
      exitCode: exitCode ?? '',
      stderrHead: byteCap(String(stderrHead || ''), 120).replace(/\n/g, ' '),
      howClose: byteCap(String(howClose || ''), 120).replace(/\n/g, ' '),
    });
  }

  toTable() {
    if (this.rows.length === 0) return '(no attempts yet)';
    // Escape `|` too, not just newlines — a pipe in captured stderr (shell pipelines, ASCII
    // tables) would otherwise shift columns and garble the "already tried" record the writer
    // relies on (round 5 review #2, matching lineage.mjs/report.mjs).
    const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const head = '| # | outcome | prompt | error | how close |\n|---|---|---|---|---|';
    const body = this.rows.map(r =>
      `| ${r.iteration} | ${cell(r.outcome)} | ${cell(r.prompt)} | ${cell(r.stderrHead)} | ${cell(r.howClose)} |`
    ).join('\n');
    return `${head}\n${body}`;
  }
}
