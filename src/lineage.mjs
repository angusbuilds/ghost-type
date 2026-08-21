// src/lineage.mjs
// Prompt lineage: every auto-written next-prompt is logged with the iteration it belongs to
// and the outcome it produced, so the invisible prompt-writing decision becomes auditable.
import fs from 'node:fs';
import path from 'node:path';

export function recordLineage(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
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
