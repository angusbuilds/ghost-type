// src/report.mjs
// Markdown-first (spec: HTML wrapper is later). Status strip in columns first,
// then collapsible per-card detail — respects "show, don't wall-of-prose".

export function renderReport(night) {
  const strip = [
    `# Ghost Type — ${night.date}`,
    '',
    `**${night.cards.filter(c => c.mergeReady).length} shipped · ${night.cards.filter(c => c.outcome === 'parked').length} parked · ${night.tokens} tokens · $${night.costUsd.toFixed(2)}**`,
    night.tripReason ? `\n> stopped early: ${night.tripReason}` : '',
    '',
    '| project | merge-ready | why |',
    '|---|---|---|',
    ...night.cards.map(c => `| ${c.project} | ${c.mergeReady ? '✅' : '—'} | ${c.whyLine} |`),
    '',
  ];
  const detail = night.cards.flatMap(c => [
    `## ${c.project} — ${c.outcome}`,
    `**Goal:** ${c.goal}`,
    `**Branch:** \`${c.branch}\` · **iterations:** ${c.iterations}`,
    c.sleptGap ? `> machine slept: ${c.sleptGap}` : '',
    '<details><summary>test output</summary>',
    '', '```', c.testOutput || '(none)', '```', '', '</details>',
    c.promptsWritten.length ? '<details><summary>prompts the ghost wrote (grade 👍/👎)</summary>\n' : '',
    ...c.promptsWritten.map(p => `- ${p}`),
    c.promptsWritten.length ? '\n</details>' : '',
    '',
  ].filter(Boolean));
  return [...strip, ...detail].join('\n');
}
