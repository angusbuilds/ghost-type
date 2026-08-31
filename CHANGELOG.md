# Changelog

All notable changes to Ghost Type. Dates are the day the work landed.

## [0.2.1] — 2026-08-30

- **`ghost join [name]`** — the enrollment half of menu-bar driving. Typed in any terminal,
  it wraps that terminal in a tmux session named after the project directory (same tab,
  `-A` so re-joining a project reattaches), which makes it appear in the dropdown and
  become driveable. Driving stays tmux-only on purpose — `send-keys` + `capture-pane` is
  the whole safety story; `join` turns that constraint into one word instead of a tmux
  lesson. Not a tty → clear guidance, exit 1; already inside tmux → says so, exit 0.
- **Dropdown empty state teaches the move** — "type `ghost join` in any terminal to add it"
  replaces the dead-end "no tmux sessions running".
- For a session already running outside tmux: `Ctrl-C` → `ghost join` → `claude --continue`
  brings it back with history, now visible in the menu bar.

## [0.2.0] — 2026-08-30

The menu bar drives for real now — the one item the audit campaign deferred
(`docs/menu-bar-drive-decision.md`, Option A: pick a session, type a goal in a panel under
the status item, return starts a real drive).

### The menu bar drives
- **A real drive, not a wish** — click an idle session row and the menu closes; a small
  borderless keyboard panel appears flush under the status item with a goal text field;
  Return spawns a detached `ghost drive`, Escape or click-away cancels. Click a driving row
  and it's an immediate `ghost undrive`, no panel.
- **Headroom-style flush dropdown** — the status item click opens an `NSMenu` +
  `NSHostingView` sitting flush under the menu bar, no gap, no arrow — replaces the old
  `NSPopover`. The hero numeral is the count of sessions currently in the list that are also
  live-driving — not the raw live-drive count, so a pane that just closed but whose drive
  process hasn't noticed yet can't make the numeral disagree with the row list below it; each
  session row shows the violet dot + "driving" only when `ghost drives --json` actually lists
  it, so the state is truthful for CLI-started drives and survives an app restart.
- **Quit is scoped** — stops only the drives the app itself spawned; a drive started from
  the CLI keeps running.
- Haunt-only tinting is out of the UI (the CLI keeps `ghost haunt`/`ghost unhaunt`).

### A verified-process fact, not a UI flag
- **New `src/drives.mjs`** — a drive registry at `~/.ghosttype/drives.json` mapping
  `paneId -> {pid, goal, engine, startedAt}`. `liveDrives()` checks each pid against the
  real process table: it finds the `drive` token in that pid's `ps` argv, skips any
  `--engine`/`--max` flag+value pair, and requires the very next token to equal the paneId
  exactly — not a substring/containment check, so a stale entry for `%1` can't match a live
  `%12`, and a paneId that only happens to appear inside another drive's free-text goal can't
  be mistaken for the real positional — and heals dead entries out of the file as it goes, so
  a killed drive can't wedge into permanent "driving." `stopDrive()` only `SIGINT`s a pid it
  has just verified is live — pid reuse can't hijack it.
- **`ghost drive <pane> "<goal>"` refuses a double-drive** — a pane that's already live
  exits 2 with `usage: already driving %N (pid P) — ghost undrive %N first`. It registers on start
  and always deregisters, on both the normal exit path and `SIGINT`, pid-guarded so it never
  clears someone else's entry.
- **New `ghost drives [--json]`** — lists live drives; `--json` prints
  `{"%3":{"pid":123,"goal":"...","engine":"claude","startedAt":"..."}}`, exactly the shape
  the menu bar polls.
- **New `ghost undrive <pane>`** — `SIGINT`s the live drive (its own handler untints and
  deregisters) and also unhaunts directly, so it heals a stale tint left by an uncleanly
  killed drive; prints `stopping %3 (pid 123)` or `%3 is not being driven`.
- `ghost sessions --json` rows now carry `paneId`, `session`, `loc`, `cmd`, `windowName`,
  `title`, `target` — what the menu bar needs to render and target a row.

### CI
- Switched to `workflow_dispatch` — push-triggered runs on a private repo hit Actions
  billing and sat as a permanent red ✗ that said nothing about the code.

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
  battery/disk arm-checks, caffeinate + heartbeat lifecycle, launchd agent
  (`deploy/com.ghosttype.night.plist`) for scheduled overnight runs.
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

### Hardening (rounds 6–12)
- **Timeouts that actually stop** — every engine + acceptance call runs under a wall-clock
  deadline that settles independently of process exit and kills the whole process group, so a
  detached grandchild can't hang the run.
- **Candidate integrity** — before the (agent-modifiable) acceptance test runs, the full
  candidate tree is frozen (`git write-tree`, tracked + untracked, `.gitignore`-aware); any change
  to it afterward is refused. This defeats a rigged test that erases or rewrites its own patch to
  fake a pass — including the untracked-file and content-corruption variants.
- **Opt-in OS sandbox** (`"sandbox": true`, macOS) — confines the coding session's writes to the
  clone (network stays up for the API) and denies network in the acceptance test; for untrusted repos.
- **Codex actually works** — the parser was rewritten for the current `codex` 0.148 event schema
  and the adapter no longer hangs on stdin; both Claude and Codex are now live-validated shipping
  a real feature end-to-end.
- **Hard caps bound every call** — budget = `min(card, remaining$)`, timeout = `min(45min,
  to-deadline)`, on the main call and every writer call; the night parks below a floor.
- Plus: all GitHub/Stripe secret formats; per-file/aggregate/binary destructive-diff detection;
  fail-closed power/disk/arm checks; crash-orphan preservation.

### Hardening (rounds 13–20)
- **Sterile snapshot** — the candidate tree is now built from RAW filesystem bytes
  (`hash-object --no-filters` into a throwaway index, every executable git-config path disabled),
  so no repo-controlled clean/smudge/ident filter, fsmonitor hook, or stale-index flag can run code
  in the daemon or make the frozen tree differ from the bytes acceptance tested.
- **Submodule integrity** — a clean gitlink is preserved; a dirty, deleted, type-changed, or moved
  submodule is refused; an **added/content-changed gitlink is refused outright** (its nested commit
  can't be published, so the branch would reference an unavailable object).
- **Per-card boundary** — one card's clone/commit/unborn-HEAD throw now parks that card and the
  night continues (`runCardSafely`), instead of aborting the whole queue.
- **Same-day reruns don't collide** — a repeated goal ships a sibling `ghost/…-2` branch instead of
  being silently rejected as a non-fast-forward on fetch-back.
- **Disk hygiene, safely** — a completed clone is reaped once its verified commit is OID-pinned back
  in the source repo, **unless** it holds candidate-created ignored state absent from the shipped
  tree (that clone is preserved for review).
- **Unsupported repos are refused at scan** — unborn (no-commit) repos, and repos using git-LFS /
  check-in filters / `working-tree-encoding`, are marked non-runnable with a clear reason rather than
  silently shipping a broken or noncanonical tree. (`text=auto` line-ending repos stay runnable.)
- **Accounting** — the night's cost is sourced from the governor (a card that throws after metering
  no longer drops its spend); a fetch-back failure parks with the real error, not a false "shipped".
- **Newline-in-filename** paths snapshot via NUL-delimited `update-index -z --index-info`.

### Hardening (rounds 21–28 + self-audit)
Rounds 21–27 finished the snapshot to the niche tail (case-only renames across every path — leaf,
parent dir, gitlink; nested untracked repos; non-ignored empty dirs git can't store — all refused).
**Round 28 broadened the audit past the verifier and found the loop's real bugs:**
- **The token cap actually counts now** — usage summed only input+output, undercounting a cached
  Claude call ~300× (937 vs 285,759). It sums all four buckets (incl. both cache tiers).
- **A card can reach its iteration budget** — a failing acceptance test used to trip the
  consecutive-*engine*-error breaker, parking a 6-iteration card at 3. Test failures now count only
  against the card's iterations; the breaker is scoped to real engine/transport failures.
- **Usage limits are handled, not misread** — Claude reports a limit as the contradictory
  `subtype:success, is_error:true`; Codex as `turn.failed`. Both were misclassified (done / generic
  error) and are now rate-limited (the night waits for the real reset, parsed from absolute clock
  times too). One shared `engineFailed()` also stops a limit message from leaking into the next
  prompt, a preflight candidate, a proposal plan, or the learned voice profile.
- **It can actually run your repo** — the agent may now install the clone's missing dependencies
  (`git clone` omits `node_modules`), scoped to the detected package manager's install verb, in both
  default and sandbox modes. The package manager is detected (pnpm/yarn/bun), not assumed to be npm.
- **The voice stays yours** — learning excludes sidechain/daemon/Ghost-authored rows (verified 0
  leaks against the real corpus); a failed `ghost learn` no longer overwrites the profile with an
  error string; the situation-specific exemplar is never dropped.
- **Nothing is silently lost** — proposal cards write a real `PLAN.md`; cards unstarted after a
  governor trip are reported `skipped`; a same-day rerun ships a sibling branch, not a lost non-ff.
- **The crash backlog is visible** — crashed clones are quarantined and preserved forever (never
  auto-deleted — they may hold the only copy of a night's work), which meant they piled up unseen
  until the 20GB disk floor silently blocked arming. `ghost doctor` now reports the quarantine
  count and footprint so the owner can review and clear them — advisory, never fatal.

### Proof
- 378 offline unit tests (`node --test`), zero runtime dependencies.
- Soup-to-nuts e2e on real git/fs (only the LLM scripted), incl. committed-deletion and
  test-erases-its-own-patch attacks.
- Live-validated: both Claude and Codex shipped a real feature end-to-end (real tokens, main
  untouched, no push); the OS sandbox verified to block external writes while keeping the API up.
- **Dependency bootstrap proven end-to-end** — a real card whose acceptance (`npm test`) needs an
  uninstalled dependency was driven through the live runner: iteration 1 failed (dep missing), the
  writer diagnosed it and rewrote the prompt to `npm install` first, iteration 2 installed and
  passed. The shipped tree carries `package-lock.json` but not `node_modules`.
- **Per-pane tint verified against real tmux 3.7b** — `select-pane -P` sets and clears the pane
  background as intended (an integration test drives the real command, not a mock).
- Independently audited by Codex (`gpt-5.6-sol`, xhigh) across twenty-eight rounds — each round
  verifying the prior round's fixes held and were complete, not just plausible.
