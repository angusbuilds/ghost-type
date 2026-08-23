// src/preflight.mjs
// Cheap pre-flight: draft a few candidate next-prompts and let a fast model vote for the
// one likeliest to make progress, before a full (expensive) coding session is ever spent.
import { byteCap, engineFailed } from './lib.mjs';

const CAND_CAP = 4000;    // one candidate prompt should be short
const VOTE_CAP = 40000;   // the whole assembled vote prompt

// Text from an engine call is only usable if the CALL SUCCEEDED — otherwise a transport failure
// ("spawn error", "network unreachable") OR a structured provider error (a rate/usage limit reported
// as is_error:true, exit 0) would become a candidate/prompt (round 5 M5 / round 28 #3-variant).
function okText(r) {
  if (engineFailed(r)) return '';
  return String(r?.text || '').trim();
}

export async function generateCandidates({ context, n = 3, engine }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = await engine({ prompt: `${context}\n\nDraft ONE candidate next-prompt (variant ${i + 1} — take a different angle than an obvious first try). Output only the prompt.` });
    const t = okText(r);
    if (t) out.push(byteCap(t, CAND_CAP));   // cap each candidate — a runaway response can't bloat the vote prompt (round 7 Medium#2)
  }
  return out;
}

export async function voteBest({ candidates, context, engine }) {
  if (candidates.length <= 1) return { choice: candidates[0] ?? '', index: 0 };
  const list = candidates.map((c, i) => `CANDIDATE ${i}:\n${byteCap(String(c), CAND_CAP)}`).join('\n\n');
  // The JSON-format instruction is fixed-size and tells the judge HOW to answer — reserve room for it and
  // cap only the context/candidate body, else a large context truncated it off the tail so parseChoice
  // found no JSON and every vote silently fell back to candidate 0, wasting the whole preflight (round 33).
  const trailer = '\n\nAnswer strictly as JSON: {"choice": <index>, "reason": "..."}.';
  const body = `${context}\n\nHere are candidate next-prompts. Pick the ONE most likely to make real progress.\n\n${list}`;
  const r = await engine({
    prompt: byteCap(body, VOTE_CAP - Buffer.byteLength(trailer)) + trailer,
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
