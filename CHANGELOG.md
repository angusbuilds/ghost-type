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

### Proof
- 156 offline unit tests (`node --test`), zero runtime dependencies.
- Soup-to-nuts e2e on real git/fs (only the LLM scripted).
- A live smoke shipped a real feature end-to-end with real tokens, main untouched.
