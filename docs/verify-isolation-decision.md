# Decision needed: how hard to close the "mutate-then-restore" verify gap

The verifyCard flow audit (round 31) surfaced one real integrity gap that is **not**
a quick fix — it's a design tradeoff. This writes it up so it's a decision, not a
buried TODO. Everything else the audit found is fixed or dispositioned.

## The gap, precisely

Ghost Type runs the acceptance test **in the writable clone**, then freezes the tree
before and after and refuses if they differ (the "snapshot sandwich"). That catches a
test that mutates the tree and leaves it mutated. It does **not** catch a test that:

1. modifies tracked source/tests so it passes,
2. runs against those altered bytes,
3. **restores** the original bytes,
4. exits 0.

`treeBefore === treeAfter` (identical endpoints), so it ships `treeBefore` — even though
the substantive test ran against different bytes than what ships. A rigged acceptance
test can thus fake a pass.

## Why it isn't already fixed

The current design **deliberately** runs acceptance in the writable clone: real test
suites need to write (install deps, emit coverage, generate caches). The snapshot is
raw-byte and hook-free precisely so a hostile filter can't execute — but that same
choice means the test runs in a place it can mutate.

## Current mitigation (already in place)

- The **morning diff review**: every shipped branch is reviewed by the owner before
  merge. A mutate-then-restore that shipped wrong code shows up as code that doesn't
  actually satisfy its own tests on inspection.
- The threat is a **rigged test in the repo itself**, not the agent — and the agent
  can't add a passing-but-hollow test without the destructive-diff / neuter guards
  (test-file deletion, `scripts.test` neutering) also firing.

So it's a real gap, but a narrow one, behind a human gate.

## The options

| Option | What | Cost | Breaks |
|---|---|---|---|
| **A — read-only tracked checkout** | materialize `treeBefore`, run acceptance there with TRACKED paths read-only, writes allowed only to untracked/gitignored paths + tmp | med | tests that legitimately rewrite a TRACKED file (snapshot `.snap` updates, formatters, codegen-into-tree) |
| **B — mtime/hash tripwire** | snapshot tracked-file hashes+mtimes before, re-check after; refuse if a tracked file was written during the run even if restored | small | same false-positives as A, but detected *after* wasting the test run |
| **C — keep as-is** | rely on the morning review + the existing guards | none | nothing; leaves the narrow gap |

## Recommendation

**A, gated behind the existing `sandbox` config flag** (or its own flag), default off.
Read-only-tracked confinement is the correct integrity model, and most suites write only
to gitignored paths (node_modules, coverage, dist) — those still pass. Turning it on for
untrusted repos closes the gap; leaving it off keeps snapshot-updating/formatting suites
working. B is strictly worse (same breakage, later detection). C is the honest status quo
and is defensible given the human gate, but it leaves the hole open for an unattended,
unreviewed pipeline.

## Why this is deferred (not done autonomously)

It changes where acceptance executes and **will break a class of legitimate tests**
(anything that rewrites a tracked file). That's a product tradeoff — stricter integrity
vs. compatibility — and it should be Angus's call, not an autonomous change that silently
starts parking cards whose test suites format or regenerate tracked files. The safe
default (off) and the flag design are above; wiring is ~a day once the tradeoff is chosen.
