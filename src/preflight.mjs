// src/preflight.mjs
// Cheap pre-flight: draft a few candidate next-prompts and let a fast model vote for the
// one likeliest to make progress, before a full (expensive) coding session is ever spent.

export async function generateCandidates({ context, n = 3, engine }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = await engine({ prompt: `${context}\n\nDraft ONE candidate next-prompt (variant ${i + 1} — take a different angle than an obvious first try). Output only the prompt.` });
    const t = (r.text || '').trim();
    if (t) out.push(t);
  }
  return out;
}

export async function voteBest({ candidates, context, engine }) {
  if (candidates.length <= 1) return { choice: candidates[0] ?? '', index: 0 };
  const list = candidates.map((c, i) => `CANDIDATE ${i}:\n${c}`).join('\n\n');
  const r = await engine({
    prompt: `${context}\n\nHere are candidate next-prompts. Pick the ONE most likely to make real progress.\n\n${list}\n\nAnswer strictly as JSON: {"choice": <index>, "reason": "..."}.`,
  });
  try {
    const j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || [])[0]);
    const index = Number(j.choice);
    if (Number.isInteger(index) && index >= 0 && index < candidates.length) return { choice: candidates[index], index };
  } catch { /* fall through */ }
  return { choice: candidates[0], index: 0 };   // fail-safe: first draft
}
