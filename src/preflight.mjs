// src/preflight.mjs
// Cheap pre-flight: draft a few candidate next-prompts and let a fast model vote for the
// one likeliest to make progress, before a full (expensive) coding session is ever spent.

// Text from an engine call is only usable if the CALL SUCCEEDED — otherwise a transport
// failure ("spawn error", "network unreachable") would become a candidate/prompt (round 5 M5).
// A mock/simple writer (no exitCode) is trusted; only an explicit nonzero exit is discarded.
function okText(r) {
  if (!r) return '';
  if (r.exitCode != null && r.exitCode !== 0) return '';
  return String(r.text || '').trim();
}

export async function generateCandidates({ context, n = 3, engine }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = await engine({ prompt: `${context}\n\nDraft ONE candidate next-prompt (variant ${i + 1} — take a different angle than an obvious first try). Output only the prompt.` });
    const t = okText(r);
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
  const text = okText(r);
  const index = parseChoice(text, candidates.length);
  if (index != null) return { choice: candidates[index], index };
  return { choice: candidates[0], index: 0 };   // fail-safe: first draft
}

// Extract the chosen index robustly: try to parse the first JSON object, but fall back to a
// direct "choice": N scan so trailing prose after the JSON can't force a silent index-0 vote
// (round 5 review #8).
function parseChoice(text, count) {
  const valid = (n) => (Number.isInteger(n) && n >= 0 && n < count) ? n : null;
  const m = text.match(/\{[\s\S]*?\}/);   // non-greedy: stop at the first close brace
  if (m) { try { const v = valid(Number(JSON.parse(m[0]).choice)); if (v != null) return v; } catch { /* fall through */ } }
  const direct = text.match(/"?choice"?\s*[:=]\s*(\d+)/i);
  return direct ? valid(Number(direct[1])) : null;
}
