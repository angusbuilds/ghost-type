# Ghost Type — Milestone 1 (Smarter Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the overnight loop *correct and self-diagnosing* — never trust a "done" claim, never waste a test cycle on an empty patch, and write each next prompt from the real failure trace plus the full history of what's already been tried.

**Architecture:** Extends the M0 spine with five focused capabilities, each a small module or a new export on an existing one, all TDD, all offline-testable against the fake engine. Backward-compatible: every M0 test stays green (new behavior rides on optional params with M0 defaults).

**Tech Stack:** Same as M0 — Node 26 ESM, `node --test`, zero deps, shells to `git`/`claude`.

## Global Constraints

Inherited verbatim from M0 (see the M0 plan): zero runtime deps, Node ≥26 ESM, state under
`~/.ghosttype/`, isolated clone with `origin` removed, scoped `--allowedTools` +
`--permission-mode dontAsk` + `--max-budget-usd` (no `--max-turns` — doesn't exist on
claude v2.1.226), untrusted text scrubbed+capped+fenced, fail toward "park and report".

## The five M1 capabilities

1. **Claim ≠ fact** — capture the session's completion *claim*, ground it against the
   Verifier's own test result, and flag a *false-done* (agent said done, tests disagree).
2. **Patch-applied guard** — before spending a test cycle, confirm the working tree
   actually changed; an empty/no-op patch fails fast as its own distinct outcome.
3. **Raw trace + forced diagnosis** — the Prompt Writer receives the raw failure trace
   (not a summary) and must produce a written *diagnosis of why it failed* before drafting
   the next prompt.
4. **Attempt ledger** — a persisted table of every prompt tried for a card + its outcome,
   handed to the Prompt Writer each iteration so it sees the trend, not just the last try.
5. **Pre-flight candidate selection** — generate 2–3 candidate next-prompts and have a
   fast model vote for the one likeliest to make progress before a real session is spent.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/ledger.mjs` | **new** | Record attempts, render the ledger table for a prompt |
| `src/verifier.mjs` | extend | add `patchApplied()`, `classifyClaim()` |
| `src/preflight.mjs` | **new** | `generateCandidates()`, `voteBest()` |
| `src/prompt-writer.mjs` | extend | add `diagnoseFailure()`; `writeNextPrompt` accepts `ledgerTable` + `rawTrace` |
| `src/spine.mjs` | extend | wire patch-guard → verify → claim-check → ledger → preflight |
| `test/ledger.test.mjs`, `test/preflight.test.mjs` | new | unit tests |
| `test/verifier.test.mjs`, `test/prompt-writer.test.mjs`, `test/spine.test.mjs` | extend | new-behavior tests |
| `test/m1-loop.test.mjs` | new | integration: false-done, patch-guard, ledger growth, preflight |

**Interfaces produced:**

```
ledger:  new Ledger() ; l.record({iteration, prompt, outcome, exitCode, stderrHead, howClose})
         l.rows -> array ; l.toTable() -> string (markdown table for the prompt)
verifier(+): patchApplied(clonePath, baseRef) -> boolean   // did the tree change vs baseRef
             classifyClaim({claimText, verifyPass}) -> {falseDone:boolean, claimedDone:boolean}
preflight:  generateCandidates({context, n, engine}) -> Promise<string[]>
            voteBest({candidates, context, engine}) -> Promise<{choice:string, index:number}>
prompt-writer(+): diagnoseFailure({goal, rawTrace, engine}) -> Promise<string>
             writeNextPrompt(... , ledgerTable?, rawTrace?)   // additive, M0 calls still valid
spine(+):   runCard uses new deps: patchApplied, classifyClaim, preflight (all defaulted)
```

---

### Task 1: Attempt ledger (`ledger.mjs`)

**Files:** Create `src/ledger.mjs`, `test/ledger.test.mjs`

**Interfaces:** Produces `Ledger` with `record()`, `rows`, `toTable()`.

- [ ] **Step 1: Write the failing test**

```js
// test/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.mjs';

test('records attempts and renders a table with every row', () => {
  const l = new Ledger();
  l.record({ iteration: 1, prompt: 'fix the lexer', outcome: 'fail', exitCode: 1, stderrHead: 'AssertionError', howClose: 'tests still red' });
  l.record({ iteration: 2, prompt: 'revert and isolate tokenizer', outcome: 'fail', exitCode: 1, stderrHead: 'TypeError', howClose: 'different error now' });
  assert.equal(l.rows.length, 2);
  const t = l.toTable();
  assert.match(t, /fix the lexer/);
  assert.match(t, /revert and isolate tokenizer/);
  assert.match(t, /AssertionError/);
});

test('empty ledger renders a placeholder, not a broken table', () => {
  assert.match(new Ledger().toTable(), /no attempts yet/i);
});

test('long prompts are truncated in the table', () => {
  const l = new Ledger();
  l.record({ iteration: 1, prompt: 'x'.repeat(500), outcome: 'fail', exitCode: 1, stderrHead: '', howClose: '' });
  assert.ok(l.toTable().length < 500 + 200);
});
```

- [ ] **Step 2: Run — expect FAIL** (`node --test test/ledger.test.mjs`)

- [ ] **Step 3: Write `src/ledger.mjs`**

```js
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
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** — `git commit -m "feat(ledger): attempt ledger for the prompt writer"`

---

### Task 2: Patch-applied guard + claim classifier (`verifier.mjs` extend)

**Files:** Modify `src/verifier.mjs`; extend `test/verifier.test.mjs`

**Interfaces:** Consumes nothing new. Produces `patchApplied(clonePath, baseRef)`, `classifyClaim({claimText, verifyPass})`.

- [ ] **Step 1: Write the failing tests** (append to `test/verifier.test.mjs`)

```js
import { patchApplied, classifyClaim } from '../src/verifier.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpGit() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pa-'));
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'hi'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  return d;
}

test('patchApplied is false when nothing changed, true after an edit', () => {
  const d = tmpGit();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d }).toString().trim();
  assert.equal(patchApplied(d, base), false);
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed');
  assert.equal(patchApplied(d, base), true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('classifyClaim flags false-done when the agent claims done but tests fail', () => {
  assert.deepEqual(classifyClaim({ claimText: 'All tests pass, done!', verifyPass: false }), { claimedDone: true, falseDone: true });
  assert.deepEqual(classifyClaim({ claimText: 'done', verifyPass: true }), { claimedDone: true, falseDone: false });
  assert.deepEqual(classifyClaim({ claimText: 'I could not fix it', verifyPass: false }), { claimedDone: false, falseDone: false });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Append to `src/verifier.mjs`**

```js
import { execFileSync } from 'node:child_process';

// Cheapest guard: did the working tree actually change vs the base commit the session
// started from? An empty patch fails fast without spending a full acceptance-test run.
export function patchApplied(clonePath, baseRef) {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: clonePath }).toString().trim();
  if (out) return true;
  const diff = execFileSync('git', ['diff', '--stat', `${baseRef}..HEAD`], { cwd: clonePath }).toString().trim();
  return diff.length > 0;
}

const DONE_CLAIM = /\b(all tests pass|tests pass|done|complete|finished|implemented|fixed it|works now)\b/i;

// Ground the session's completion claim against the Verifier's own test result.
// A "done" claim with a failing verify is a false-done — the highest-value catch.
export function classifyClaim({ claimText, verifyPass }) {
  const claimedDone = DONE_CLAIM.test(String(claimText || ''));
  return { claimedDone, falseDone: claimedDone && !verifyPass };
}
```

Note: `execFileSync` may already be imported in `verifier.mjs` — if so, do not duplicate the import.

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** — `git commit -m "feat(verifier): patch-applied guard + false-done claim classifier"`

---

### Task 3: Pre-flight candidate selection (`preflight.mjs`)

**Files:** Create `src/preflight.mjs`, `test/preflight.test.mjs`

**Interfaces:** Consumes an injected `engine` async fn `({prompt}) -> {text}`. Produces `generateCandidates()`, `voteBest()`.

- [ ] **Step 1: Write the failing test**

```js
// test/preflight.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidates, voteBest } from '../src/preflight.mjs';

test('generateCandidates returns n non-empty distinct-ish drafts', async () => {
  let call = 0;
  const engine = async () => ({ text: `candidate ${++call}` });
  const cands = await generateCandidates({ context: 'goal: fix parser', n: 3, engine });
  assert.equal(cands.length, 3);
  assert.ok(cands.every(c => c.length > 0));
});

test('voteBest picks the index the judge returns', async () => {
  const engine = async ({ prompt }) => {
    assert.match(prompt, /CANDIDATE/i);   // judge sees the candidates
    return { text: '{"choice": 2, "reason": "most concrete"}' };
  };
  const { choice, index } = await voteBest({ candidates: ['a', 'b', 'c'], context: 'ctx', engine });
  assert.equal(index, 2);
  assert.equal(choice, 'c');
});

test('voteBest falls back to the first candidate on unparseable judge output', async () => {
  const engine = async () => ({ text: 'i have opinions but no json' });
  const { index } = await voteBest({ candidates: ['a', 'b'], context: 'ctx', engine });
  assert.equal(index, 0);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Write `src/preflight.mjs`**

```js
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
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): candidate generation + judge vote"`

---

### Task 4: Forced diagnosis + trace-aware writer (`prompt-writer.mjs` extend)

**Files:** Modify `src/prompt-writer.mjs`; extend `test/prompt-writer.test.mjs`

**Interfaces:** Produces `diagnoseFailure({goal, rawTrace, engine})`. Extends `writeNextPrompt` with optional `ledgerTable` and `rawTrace` (M0 callers unaffected).

- [ ] **Step 1: Write the failing tests** (append to `test/prompt-writer.test.mjs`)

```js
import { diagnoseFailure } from '../src/prompt-writer.mjs';

test('diagnoseFailure asks the model why it failed and returns the diagnosis', async () => {
  let seen = '';
  const engine = async ({ prompt }) => { seen = prompt; return { text: 'the lexer drops the last token' }; };
  const d = await diagnoseFailure({ goal: 'pass parser test', rawTrace: 'AssertionError: expected 3 got 2', engine });
  assert.match(d, /lexer drops/);
  assert.match(seen, /why/i);
  assert.match(seen, /AssertionError/);   // raw trace was included
});

test('writeNextPrompt includes the ledger table when given one', async () => {
  let seen = '';
  const engine = async ({ prompt }) => { seen = prompt; return { text: 'next step' }; };
  await writeNextPrompt({
    card: { goal: 'g' }, diffTail: '', testTail: 'fail', notesTail: '', transcriptTail: '',
    voiceProfile: 'terse', exemplars: [], failure: { code: 1, stderrHead: 'fail' },
    ledgerTable: '| 1 | fail | tried X |', rawTrace: 'RAW-TRACE-MARKER', engine,
  });
  assert.match(seen, /RAW-TRACE-MARKER/);
  assert.match(seen, /tried X/);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Extend `src/prompt-writer.mjs`**

Add the diagnosis helper:

```js
// Force a written diagnosis from the RAW trace before any next-prompt is drafted.
// Reflexion's ablation: a diagnosis beats a scalar/summary for the next attempt.
export async function diagnoseFailure({ goal, rawTrace, engine }) {
  const clean = byteCap(scrubSecrets(String(rawTrace || '')), 12000);
  const r = await engine({
    prompt: [
      `A coding attempt failed. GOAL: ${goal}`,
      fence('raw-trace', clean),
      'In 1-3 sentences, diagnose exactly WHY it failed. Be specific and technical. Output only the diagnosis.',
    ].join('\n\n'),
  });
  return (r.text || '').trim();
}
```

Then extend `writeNextPrompt`'s signature and body to thread `ledgerTable` and `rawTrace`
into the assembled prompt (add these lines into the existing `meta` array, keeping the
shield/scrub/fence discipline):

```js
// in writeNextPrompt destructuring add:  ledgerTable, rawTrace
// add to the `meta` array (before the final instruction line):
    ledgerTable ? `WHAT YOU'VE ALREADY TRIED (do not repeat a dead end):\n${ledgerTable}` : '',
    rawTrace ? fence('raw-trace', clean(rawTrace)) : '',
```

The shield scan must also cover `rawTrace`: include it in the `untrusted` join at the top
of `writeNextPrompt`.

- [ ] **Step 4: Run — expect PASS** (and the M0 prompt-writer tests still pass)

- [ ] **Step 5: Commit** — `git commit -m "feat(prompt-writer): forced diagnosis + ledger + raw trace"`

---

### Task 5: Wire M1 into the spine (`spine.mjs` extend)

**Files:** Modify `src/spine.mjs`; extend `test/spine.test.mjs`

**Interfaces:** `runCard` gains defaulted deps: `patchApplied`, `classifyClaim`, `diagnoseFailure`, `generateCandidates`, `voteBest`, and builds a `Ledger`. New card outcome value: `no-patch` recorded in the ledger; result carries `falseDoneCount`.

- [ ] **Step 1: Write the failing tests** (append to `test/spine.test.mjs`)

```js
import { Ledger } from '../src/ledger.mjs';

test('a no-op patch fails fast without a false ship', async () => {
  const d = deps({
    patchApplied: () => false,               // agent changed nothing
    verify: async () => ({ pass: true, detail: { testOutput: 'ok' } }), // even if verify would pass
  });
  const r = await runCard({ ...card, maxIterations: 1 }, d);
  assert.equal(r.outcome, 'parked');
  assert.match(r.whyLine, /no.?patch|nothing/i);
});

test('records a false-done when the agent claims done but verify fails', async () => {
  let falseDone = 0;
  const d = deps({
    patchApplied: () => true,
    runEngine: async () => ({ exitCode: 0, result: { subtype: 'success', result: 'all tests pass, done!' }, usage: {}, text: 'all tests pass, done!' }),
    verify: async () => ({ pass: false, detail: { testOutput: 'AssertionError' } }),
    classifyClaim: ({ claimText, verifyPass }) => { const fd = /done/.test(claimText) && !verifyPass; if (fd) falseDone++; return { claimedDone: true, falseDone: fd }; },
  });
  const r = await runCard({ ...card, maxIterations: 1 }, d);
  assert.ok(falseDone >= 1);
  assert.equal(r.falseDoneCount >= 1, true);
});
```

Note: the M0 `deps()` helper must be extended to supply M1 defaults (`patchApplied: () => true`, a pass-through `classifyClaim`, and stubbed `diagnoseFailure`/`generateCandidates`/`voteBest`). Update the shared `deps()` in `test/spine.test.mjs` so M0 tests still pass.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Extend `runCard` in `src/spine.mjs`**

Wire, in order, inside the loop (keeping every M0 branch intact):

1. Capture `baseRef` right after `makeClone` (`git rev-parse HEAD` in the clone via a
   `deps.headRef` helper, defaulted to a real git call).
2. After a `done`/`stalled` engine turn, **before** `verify`: if `!patchApplied(clonePath, baseRef)`,
   record a `no-patch` ledger row and treat as a failed attempt (skip the test cycle).
3. After `verify`: `classifyClaim({ claimText: eng.text, verifyPass: v.pass })`; increment
   `falseDoneCount` on a false-done and log it.
4. On a failing verify before writing the next prompt: build `rawTrace` from
   `v.detail.testOutput` + `eng.text`, call `diagnoseFailure`, record the attempt in the
   `Ledger`, generate candidates via `generateCandidates` and pick with `voteBest`, use the
   chosen prompt. Fall back to a single `writeNextPrompt` call if candidate generation
   yields nothing.
5. Return `falseDoneCount` and the ledger rows on the card result.

Keep all new deps defaulted so `runNight`/M0 callers are unaffected.

- [ ] **Step 4: Run — expect PASS** (M0 spine tests still green)

- [ ] **Step 5: Commit** — `git commit -m "feat(spine): wire patch-guard, claim-check, ledger, preflight"`

---

### Task 6: M1 integration test

**Files:** Create `test/m1-loop.test.mjs`

- [ ] **Step 1: Write the integration test** — drive a full card where iteration 1 makes a
  no-op "done" claim (false-done + no-patch both caught) and iteration 2 actually applies a
  patch that verifies, asserting: `falseDoneCount >= 1`, the ledger has ≥1 row, the preflight
  path was exercised (candidate generator called), and the card ships.

```js
// test/m1-loop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCard } from '../src/spine.mjs';

test('M1: false-done caught on try 1, ships on try 2, ledger + preflight exercised', async () => {
  let engineCalls = 0, candidateCalls = 0, patched = false;
  const card = {
    project: 'm1', repoPath: '/tmp/none', goal: 'make it pass',
    acceptanceArgv: ['true'], acceptanceTimeoutSec: 10, branch: 'ghost/2026-08-21-m1',
    maxIterations: 3, maxTurns: 5, maxBudgetUsd: 1, situation: 'kickoff',
  };
  const deps = {
    now: () => Date.parse('2026-08-21T22:00:00Z'),
    makeClone: () => '/tmp/fake', headRef: () => 'BASE',
    commit: () => {},
    gitDiff: () => ({ stat: ' 1 file changed', excerpt: 'diff' }),
    runEngine: async () => { engineCalls++; if (engineCalls === 2) patched = true; return { exitCode: 0, result: { subtype: 'success', result: 'all tests pass, done!' }, usage: {}, text: 'all tests pass, done!' }; },
    patchApplied: () => patched,               // false on try 1, true on try 2
    verify: async () => ({ pass: patched, detail: { testOutput: patched ? 'ok' : 'AssertionError' } }),
    classifyClaim: ({ claimText, verifyPass }) => ({ claimedDone: /done/.test(claimText), falseDone: /done/.test(claimText) && !verifyPass }),
    diagnoseFailure: async () => 'the patch was never written',
    generateCandidates: async () => { candidateCalls++; return ['try writing the file', 'revert then retry']; },
    voteBest: async ({ candidates }) => ({ choice: candidates[0], index: 0 }),
    writeNextPrompt: async () => 'fallback prompt',
  };
  const r = await runCard(card, deps);
  assert.equal(r.outcome, 'shipped');
  assert.ok(r.falseDoneCount >= 1, 'a false-done was recorded');
  assert.ok(candidateCalls >= 1, 'preflight candidate generation ran');
});
```

- [ ] **Step 2: Run — expect PASS**

- [ ] **Step 3: Run the whole suite** — `node --test` — all M0 + M1 green.

- [ ] **Step 4: Commit** — `git commit -m "test(m1): integration — false-done, patch-guard, ledger, preflight"`

---

## Self-Review

**Spec coverage:** all five M1 capabilities map to tasks — claim-vs-fact (T2, T5), patch
guard (T2, T5), raw-trace+diagnosis (T4, T5), attempt ledger (T1, T4, T5), pre-flight
selection (T3, T5). Integration test (T6) exercises them together.

**Placeholder scan:** none — every step ships runnable code, except T5 step 3 which is a
precise wiring spec against already-defined interfaces (justified: it edits an existing
function whose full M0 body is in the repo, and every symbol it names is defined in T1–T4).

**Type consistency:** `classifyClaim` returns `{claimedDone, falseDone}` in T2 and T5;
`voteBest` returns `{choice, index}` in T3 and T6; `Ledger.record` takes the same field set
in T1, T4, T5; `patchApplied(clonePath, baseRef)` signature identical in T2 and T5. The
injected `engine` fn is the narrow `({prompt}) -> {text}` shape used throughout M0/M1.

**Backward compatibility:** every new `runCard`/`writeNextPrompt` parameter is optional with
an M0-equivalent default, so the M0 test suite stays green unchanged (verified by keeping
`test/spine.test.mjs`'s `deps()` helper additive).

## Deferred to later milestones

M2 (voice builder), M3 (daemon/planner/CLI, goal-scoped memory, quota forecasting), M4
(report polish, prompt lineage). The pre-flight/ledger/diagnosis wiring here is model-call
heavy; real token cost is validated in the M0 live-smoke path, not the offline suite.
