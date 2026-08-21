// src/report-html.mjs
// A self-contained, theme-aware HTML morning report. Status strip first (columns, not
// prose), then collapsible per-card detail with the real test output. No external assets.
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function renderReportHtml(night) {
  const shipped = night.cards.filter(c => c.mergeReady).length;
  const parked = night.cards.filter(c => c.outcome === 'parked').length;
  const rows = night.cards.map(c => `
      <tr>
        <td>${esc(c.project)}</td>
        <td class="${c.mergeReady ? 'ok' : 'no'}">${c.mergeReady ? '✅ ready' : '— parked'}</td>
        <td>${esc(c.whyLine)}</td>
        <td class="mono">${esc(c.iterations)}</td>
      </tr>`).join('');

  const cards = night.cards.map(c => `
    <details${c.mergeReady ? ' open' : ''}>
      <summary><b>${esc(c.project)}</b> — ${esc(c.outcome)}${c.falseDoneCount ? ` <span class="flag">${c.falseDoneCount} false-done caught</span>` : ''}</summary>
      <div class="body">
        <p class="goal">${esc(c.goal)}</p>
        <p class="meta"><code>${esc(c.branch)}</code> · ${esc(c.iterations)} iteration(s)</p>
        <pre class="test">${esc(c.testOutput || '(no output)')}</pre>
        ${(c.promptsWritten || []).length ? `<div class="prompts"><h4>Prompts the ghost wrote</h4>${c.promptsWritten.map(p => `<div class="prompt">${esc(p)} <span class="grade">👍 👎</span></div>`).join('')}</div>` : ''}
      </div>
    </details>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ghost Type — ${esc(night.date)}</title>
<style>
  :root {
    --bg:#faf9fc; --card:#fff; --ink:#1a1523; --muted:#6b6577; --line:#e7e3ee;
    --purple:#5a2ca0; --ok:#1a8a4a; --no:#9a8f00; --flag:#b4341c;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#131019; --card:#1c1826; --ink:#efeaf6; --muted:#9990ab; --line:#2c2740;
      --purple:#b794f6; --ok:#4ade80; --no:#d9c94a; --flag:#f87171;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .wrap { max-width:820px; margin:0 auto; padding:40px 22px 80px; }
  h1 { font-size:26px; margin:0 0 4px; letter-spacing:-.02em; }
  .sub { color:var(--muted); margin:0 0 26px; }
  .verdict { display:inline-block; background:var(--purple); color:#fff; padding:8px 16px; border-radius:999px; font-weight:600; margin-bottom:26px; }
  table { width:100%; border-collapse:collapse; margin-bottom:34px; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th,td { text-align:left; padding:11px 14px; border-bottom:1px solid var(--line); }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  tr:last-child td { border-bottom:none; }
  td.ok { color:var(--ok); font-weight:600; } td.no { color:var(--no); font-weight:600; }
  .mono,code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  details { background:var(--card); border:1px solid var(--line); border-radius:12px; margin-bottom:14px; padding:6px 16px; }
  summary { cursor:pointer; padding:8px 0; font-size:17px; }
  .flag { color:var(--flag); font-size:13px; font-weight:600; }
  .goal { font-size:16px; margin:6px 0; }
  .meta { color:var(--muted); font-size:13px; margin:2px 0 12px; }
  pre.test { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; overflow-x:auto; font-size:13px; }
  .prompts h4 { margin:16px 0 8px; font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .prompt { background:var(--bg); border-left:3px solid var(--purple); padding:8px 12px; border-radius:0 8px 8px 0; margin-bottom:8px; font-size:14px; }
  .grade { float:right; opacity:.5; }
  footer { color:var(--muted); font-size:12px; margin-top:40px; }
</style></head>
<body><div class="wrap">
  <h1>👻 Ghost Type</h1>
  <p class="sub">${esc(night.date)}</p>
  <div class="verdict">${shipped} shipped · ${parked} parked · ${esc(night.tokens)} tokens · $${Number(night.costUsd || 0).toFixed(2)}</div>
  ${night.tripReason ? `<p class="sub">stopped early: ${esc(night.tripReason)}</p>` : ''}
  <table>
    <thead><tr><th>project</th><th>merge-ready</th><th>why</th><th>iters</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${cards}
  <footer>Review the ✅ branches, merge what's good, grade the prompts. Nothing was pushed.</footer>
</div></body></html>`;
}
