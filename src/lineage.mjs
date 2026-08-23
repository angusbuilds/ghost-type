// src/lineage.mjs
// Prompt lineage: every auto-written next-prompt is logged with the iteration it belongs to
// and the outcome it produced, so the invisible prompt-writing decision becomes auditable.
import fs from 'node:fs';
import path from 'node:path';
import { byteCap } from './lib.mjs';

const PROMPT_CAP = 2000;                  // bound each logged prompt, like ledger.mjs caps its fields
const MAX_LINEAGE_BYTES = 512 * 1024;     // keep the append-only log bounded — nothing else rotates it

export function recordLineage(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The `prompt` was written raw/uncapped, unlike every other untrusted-text sink — a runaway pasted
  // prompt would write a multi-MB line. Cap it (round 35).
  const bounded = entry?.prompt != null ? { ...entry, prompt: byteCap(String(entry.prompt), PROMPT_CAP) } : entry;
  fs.appendFileSync(file, JSON.stringify(bounded) + '\n');
  // The bin appends here on every iteration of every night forever and nothing rotates it (the read path
  // readLineage/renderLineageMd is unused in production — the report uses in-memory promptsWritten). So
  // bound the file too: when it exceeds the budget, drop the oldest half. Cheap otherwise (one statSync);
  // best-effort so a stat/rewrite failure can never break the night (round 35).
  try {
    if (fs.statSync(file).size > MAX_LINEAGE_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.slice(-Math.ceil(lines.length / 2)).join('\n') + '\n');
    }
  } catch { /* stat/rewrite best-effort */ }
}

export function readLineage(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }   // absent file → empty
  // Parse each line independently — a single truncated tail (process killed mid-append during
  // a crash/sleep) must not discard the whole audit trail (round 5 review #3).
  return raw.trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Markdown lineage table for the report: iteration → prompt → what it led to.
export function renderLineageMd(entries) {
  if (!entries.length) return '_(no prompts written)_';
  const head = '| iter | prompt | led to |\n|---|---|---|';
  const body = entries.map(e =>
    `| ${e.iteration} | ${String(e.prompt).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)} | ${e.outcome} |`
  ).join('\n');
  return `${head}\n${body}`;
}
