// src/report.mjs
// Markdown-first (spec: HTML wrapper is later). Status strip in columns first,
// then collapsible per-card detail — respects "show, don't wall-of-prose".
import { byteCap } from './lib.mjs';

// Untrusted fields (goal, whyLine, test output) reach this renderer verbatim. Neutralize the
// two ways they can break structure: a `|` or newline shattering a table row, and an embedded
// ``` closing a code fence early (round 4 #10). And BOUND the length — every other untrusted-text
// sink byte-caps, but this one didn't, so a 2MB field produced an ~8MB terminal dump / latest.md
// (round 35). A cell is a one-line summary; test output gets a larger budget.
const cell = (s) => byteCap(String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '), 800);
const fenceSafe = (s) => byteCap(String(s ?? '').replace(/```/g, '` ` `'), 8000);

export function renderReport(night) {
  const strip = [
    `# Ghost Type — ${night.date}`,
    '',
    `**${night.cards.filter(c => c.mergeReady).length} shipped · ${night.cards.filter(c => c.outcome === 'proposed').length} proposed · ${night.cards.filter(c => c.outcome === 'parked').length} parked · ${night.cards.filter(c => c.outcome === 'skipped').length} skipped · ${night.tokens ?? 0} tokens · $${Number(night.costUsd ?? 0).toFixed(2)}**`,   // never crash the never-silent report on a missing field (round 29)
    night.tripReason ? `\n> stopped early: ${cell(night.tripReason)}` : '',
    '',
    '| project | merge-ready | why |',
    '|---|---|---|',
    ...night.cards.map(c => `| ${cell(c.project)} | ${c.mergeReady ? '✅' : '—'} | ${cell(c.whyLine)} |`),
    '',
  ];
  const detail = night.cards.flatMap(c => [
    `## ${cell(c.project)} — ${cell(c.outcome)}`,
    `**Goal:** ${cell(c.goal)}`,
    `**Branch:** \`${cell(c.branch)}\` · **iterations:** ${c.iterations}`,
    c.sleptGap ? `> machine slept: ${cell(c.sleptGap)}` : '',
    '<details><summary>test output</summary>',
    '', '```', fenceSafe(c.testOutput || '(none)'), '```', '', '</details>',
    (c.promptsWritten || []).length ? '<details><summary>prompts the ghost wrote (grade 👍/👎)</summary>\n' : '',
    ...(c.promptsWritten || []).map(p => `- ${cell(p)}`),
    (c.promptsWritten || []).length ? '\n</details>' : '',
    '',
  ].filter(Boolean));
  return [...strip, ...detail].join('\n');
}
