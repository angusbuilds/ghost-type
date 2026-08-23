# Plan: dedupe the two night-loop implementations behind one tested core

**Problem.** `spine.runNight` is tested (4 assertions) but **dead** — nothing in `src/` or
`bin/` calls it. The daemon reimplements the night loop **inline** in `bin/ghost.mjs`'s
`on` case. So the tested loop isn't the loop that runs, and the real loop just had 5 wiring
bugs the tests never caught (round 31). This eliminates the drift hazard by making the
tested code the code that runs.

**Why it wasn't a loop-tick fix.** The impedance mismatch: the bin loop needs per-card deps
(lineage), an `interrupted` check, and per-card `fetchBranchBack` + `reapClone` that don't
fit `runNight`'s single-deps signature; and the bin has TWO phases (coding then proposal)
while `runNight` returns one whole-night object. The key that unblocks it: extract the
**core queue loop** (governor-gating + skip-remaining + cost) into a small helper both
callers use, with hooks for the parts that differ.

## The shared core

```js
// spine.mjs — the ONE loop. Fully unit-testable with fake deps (no engine/API needed).
export async function runCardQueue(cards, {
  now, governor,
  run = (card, d) => runCardSafely(card, d),   // coding path; proposals pass runProposal
  depsFor = () => ({}),                         // per-card deps (lineage) — bin varies this
  interrupted = () => false,                    // bin: () => interruptedFlag
  afterCard = async () => {},                   // bin: if mergeReady → fetchBranchBack + reapClone
}) {
  const results = []; let tripReason = null, started = 0;
  for (const card of cards) {
    if (interrupted()) { tripReason = 'interrupted'; break; }
    if (governor) { const c = governor.check(now()); if (!c.ok) { tripReason = c.trip; break; } }
    started++;
    const r = await run(card, { ...depsFor(card), governor });
    await afterCard(card, r);
    results.push(r);
    if (governor) { const c = governor.check(now()); if (!c.ok) { tripReason = c.trip; break; } }
  }
  const skipped = cards.slice(started).map(c => ({ project: c.project, goal: c.goal,
    outcome: 'skipped', mergeReady: false, whyLine: `not started — ${tripReason || 'queue stopped'}`,
    iterations: 0, branch: c.branch, testOutput: '', promptsWritten: [], falseDoneCount: 0, ledger: [], tokensUsed: 0, costUsd: 0 }));
  return { results: [...results, ...skipped], tripReason, started };
}
```

`runNight` becomes a thin wrapper over `runCardQueue` (its existing tests keep it honest).

## Tasks (TDD, bite-sized)

1. **Test `runCardQueue`** (fake deps): `afterCard(card, r)` called after each ship; `interrupted()` true → break + remaining skipped; a governor trip → break + `tripReason` + remaining skipped; `depsFor(card)` applied per card; cost from the governor. *(red → then step 2)*
2. **Extract `runCardQueue`**; make `runNight` delegate to it. Run the existing `runNight` + integration tests — must stay green (no behavior change).
3. **Rewire the bin coding loop** to call `runCardQueue(codingCards, {...})`, threading: `interrupted: () => interrupted`, `depsFor: card => lineageDeps(card)`, `afterCard: async (card, r) => { if (r.mergeReady) { try fetchBranchBack; reapClone unless hadIgnoredState } else park }`. **Preserve all 5 round-31 fixes** and the `runnable`/`isCodingCard` filter (applied to `codingCards` before the call). Merge its `{results, tripReason}` with the proposal phase.
4. **Optionally** run the proposal phase through `runCardQueue` too (with `run = runProposal`, a proposal-specific `afterCard`).
5. **Verify**: `node --check bin/ghost.mjs`, `test/cli-smoke.test.mjs`, full suite, and a careful diff-read confirming the coding loop's behavior (govChecks, fetch-park, reap-unless-ignored-state, lineage, interrupt) is byte-for-byte preserved.

## The one risk to respect

Step 3 restructures the daemon's highest-consequence code (a regression = a broken or
data-losing overnight run), and the bin's hook wiring stays integration-only (no night-loop
integration test exercises the real `on` case). So do step 3 **only** alongside either a new
`on`-case integration test (mock arm/reap/fetch, assert the sequence) or a live overnight
smoke — not on read-review alone. Steps 1–2 are safe and can land independently; step 3 is
the one to gate on real end-to-end verification.
