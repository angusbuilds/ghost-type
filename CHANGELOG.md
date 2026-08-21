# Changelog

All notable changes to Ghost Type. Dates are the day the work landed.

## [0.1.0] — 2026-08-21

The first end-to-end version: it can keep a coding agent working overnight and write the
next prompt in the owner's voice, driven from a CLI or a native menu-bar app.

### The loop
- **M0 spine** — one card runs clone → `claude -p` in an isolated clone → classify the
  stop → verify the acceptance test ourselves → commit-on-pass or write-the-next-prompt.
- **M1 smarter loop** — never trust a "done" claim (re-run the test, flag a *false-done*);
  patch-applied guard; raw-trace + forced diagnosis into the writer; attempt ledger;
  pre-flight vote across candidate prompts.
- **M2 voice** — `ghost learn` distills the owner's real prompting voice from
  `~/.claude` transcripts (lowercase, no `!`, keeps typos, blunt-verdict redirects).
- **M3 daemon + CLI** — `ghost scan/learn/on/off/status/queue/report`, planner, dossiers,
  battery/disk arm-checks, caffeinate + heartbeat lifecycle, launchd plist.
- **M4 report** — theme-aware HTML report, morning push notification, prompt lineage.

### Engines & UX
- **Two engines** — drives both Claude Code and Codex CLI, each prompted the way it likes.
- **Haunt mode** — `ghost sessions/haunt/unhaunt/drive`; pick a live terminal pane, it
  turns purple, and Ghost Type injects the next prompt when the agent goes idle (never a
  blind Enter, never over the human, never into a bare shell).
- **Native menu-bar app** (`app/GhostType`) — Swift/AppKit + SwiftUI, sits in the system
  vibrancy material; the menu bar shows the terminal it's driving.
- **`ghost doctor`** — environment self-check; **config** at `~/.ghosttype/config.json`.

### Safety & governance
- Isolated `git clone --no-hardlinks` with `origin` removed (separate inodes); non-Claude
  keys stripped; **token, dollar, and 07:00 caps metered before every engine call**; writer
  passes run read-only; untrusted text scrubbed/fenced/shield-gated; atomic O_EXCL+fchmod
  state writes; realpath-guarded clone/reaper; drive never types into a shell / over you /
  on an unknown probe; graceful Ctrl-C.
- **Real cost tracking** (`total_cost_usd`) surfaced in the report and enforced by a hard
  dollar cap — the direct kill-switch for the $6k-overnight-bill scenario.
- **Observability:** `ghost logs`, `ghost doctor`, the never-silent morning report.
- **Audited by Codex** (`gpt-5.6-sol`, xhigh) across multiple rounds — every finding fixed,
  each round catching what the previous round's fix left partial.

### Hardening (round 4)
- Deletion guard compares the original base to the full working tree, so a **committed**
  destructive diff can't pass acceptance — not just uncommitted ones.
- Live injection is fully fail-closed: a generic `node`/`python` process counts as an agent
  only if its argv names one; the Enter keystroke is re-guarded after the type→pause; the
  drive terminates only on a real shell prompt (never a running tool), so it can't be fooled
  by a subprocess or spin forever on an exited shell.
- Power/disk arm-checks fail **closed** — an unreadable probe (or NaN/Infinity) refuses to arm.
- Config is validated per-field (hour 0–23, integer counts, `minStable ≥ 2`, engine enum);
  an out-of-range value keeps the safe default instead of defeating a limit.
- A nonzero engine exit drops its result (classified `errored`, not a soft loop); exemplars
  are byte-capped at storage; review backpressure counts real `ghost/*` branches; the morning
  notification fires even if the report render fails; report cells/fences are escaped; a
  detected test runner counts as runnable only if its executable resolves.

### Hardening (round 5)
- **One verifier for every entrypoint** — the packaged `ghost-run-card` runner had shipped with
  no deletion guard; both runners now share `verifyCard`, so no path can accept a destructive diff.
- **Secrets actually scrubbed** — full PEM private-key blocks (not just the header) and Stripe
  `sk_live_`/`sk_test_` keys are redacted; the untrusted-data fence defangs any forged inner boundary.
- **Runaway protection** — engine calls stream into byte-capped buffers under a wall-clock deadline
  that kills the whole process group; acceptance tests drain both streams (a chatty stdout no longer
  deadlocks) and surface stdout diagnostics.
- **Credential isolation** — a session receives only the selected engine's provider keys (Codex never
  sees Anthropic keys, nor Claude OpenAI's).
- **Data-loss & accounting** — orphaned clones from a crashed night are preserved, not reaped; a
  crashed call's real cost is still metered; backpressure counts only unmerged branches.
- **Prompt-path bounds & injection** — voice profile, exemplars, ledger, and the whole assembled
  prompt are capped; a failed writer call can't become a candidate; the vote index parses robustly;
  aborted live injection clears stranded text with Ctrl-U (shell only).

### Proof
- 205 offline unit tests (`node --test`), zero runtime dependencies.
- Soup-to-nuts e2e on real git/fs (only the LLM scripted), incl. a committed-deletion attack.
- A live smoke shipped a real feature end-to-end with real tokens, main untouched.
- Independently audited by Codex (`gpt-5.6-sol`, xhigh) across five rounds — each round
  verifying the prior round's fixes held and were complete, not just plausible.
