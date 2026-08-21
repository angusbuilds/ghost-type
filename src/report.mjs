// src/report.mjs
// Markdown-first (spec: HTML wrapper is later). Status strip in columns first,
// then collapsible per-card detail — respects "show, don't wall-of-prose".

// Untrusted fields (goal, whyLine, test output) reach this renderer verbatim. Neutralize the
// two ways they can break structure: a `|` or newline shattering a table row, and an embedded
// ``` closing a code fence early (round 4 #10).
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const fenceSafe = (s) => String(s ?? '').replace(/```/g, '` ` `');

export function renderReport(night) {
  const strip = [
    `# Ghost Type — ${night.date}`,
    '',
    `**${night.cards.filter(c => c.mergeReady).length} shipped · ${night.cards.filter(c => c.outcome === 'parked').length} parked · ${night.cards.filter(c => c.outcome === 'skipped').length} skipped · ${night.tokens} tokens · $${night.costUsd.toFixed(2)}**`,
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
