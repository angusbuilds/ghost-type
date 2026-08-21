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
    const head = '| # | outcome | prompt | error | how close |\n|---|---|---|---|---|';
    const body = this.rows.map(r =>
      `| ${r.iteration} | ${r.outcome} | ${r.prompt.replace(/\n/g, ' ')} | ${r.stderrHead} | ${r.howClose} |`
    ).join('\n');
    return `${head}\n${body}`;
  }
}
