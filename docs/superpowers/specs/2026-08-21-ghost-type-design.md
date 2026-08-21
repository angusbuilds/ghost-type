# Ghost Type — Design

2026-08-21 · status: draft for review · hardened against a 4-reviewer adversarial panel

## One line

An always-on macOS daemon that keeps coding agents working on Angus's projects while
he's away: a fresh Claude session per task in a throwaway local clone, and when a
session stops, Ghost Type writes the next prompt — in his voice, learned from his own
transcripts — until the task's acceptance check actually passes. Nothing it makes can
touch his real repos, push anything, or spend money it wasn't given.

## Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Morning success | Real shipped progress: test-verified work on branches, review-and-merge |
| Work source | Send-off line on the way out; Ghost Type expands it using project state |
| Repo guardrail | Isolated **local clone** per task. Commits there. `origin` removed → push impossible. |
| Architecture | Supervisor daemon (launchd + caffeinate + pmset), fresh context per task |
| Differentiator | Prompt Writer trained on his own real session transcripts |
| Engines | v1: Claude Code headless. Phase 2: haunt mode (his live tmux sessions), Codex. |

## Why this shape (prior-art conclusions)

The field split into two solved halves nobody connected: tools that keep an agent
running (Ralph loops, Anthropic's ralph-wiggum plugin, unsnooze) and tools that learn
from your history (memory engines, output-voice cloners). Every keep-alive tool
re-sends a canned string; none writes the next prompt. Ghost Type crosses that line.
Baked-in community lessons: fresh context beats long sessions; exit conditions must be
mechanical, never the model's "I'm done"; idle ≠ done ≠ rate-limited; hard spend caps;
a next-prompt writer needs a diff sanity check.

All borrowed logic is **reimplemented, not vendored** — zero third-party code ships.
The 10 source repos were security-audited first (9 clean; Tmux-Orchestrator concepts
only, no code).

## Threat model (this runs unattended, all night, as me)

ghostd spawns coding agents with elevated permission inside clones of real repos, reads
private transcripts, and auto-writes the prompts those agents run. Assume every input it
reads — repo files, test output, `NIGHT_NOTES.md`, transcript tails — is attacker-
reachable (repos contain pasted web content, dependencies, issue text). Therefore
defenses live at the **tool-call layer**, not in prompt wording, and the whole system
fails **toward "park and report", never toward "keep burning."**

## Foundational safety mechanisms (cut across every component)

- **Throwaway local clone per task**, not a worktree. `git clone --local <repo>
  ~/.ghosttype/work/<task>` gives a fully isolated clone with its own `.git/config` +
  hooks dir, so nothing the session does can leak into the real repo's git behavior.
  (Disk-cheap because git hardlinks the `.git/objects` store when source and
  destination share a filesystem; the working tree is its own separate checkout, not
  hardlinked — so edits never touch the real repo's files.) The clone path is validated
  to be under `~/.ghosttype/work/` before any work begins. First action after clone:
  `git remote remove origin` — push, `gh`, deploy have nowhere to go. The result is
  pulled back as a branch via `git fetch` from the clone into the real repo at report
  time — never the reverse.
- **`GHOST_SESSION=1`** stamped on every spawned session's environment. A wrapper around
  `dcg` refuses `dcg allow` when that marker is present, so a ghost session can't
  disarm its own guardrails. The global dcg + guard.py PreToolUse hooks still apply
  (confirmed: headless `claude -p` runs project hooks unless `--bare`, which we never
  pass and pin explicitly).
- **Scoped permission on every session:** `--permission-mode dontAsk` +
  `--allowedTools` allowlist (`Read, Edit, Write, Bash(<test runner>), Bash(git diff
  *), Bash(git add *), Bash(git commit *), Bash(git checkout -b *)`) — deliberately
  excluding push/deploy/gh/curl. (Precedence checked: a session settings `defaultMode`
  does NOT override an explicit `--permission-mode`, so we pass it every time.)
- **Env hygiene:** the session environment is built from an allowlist, not inherited.
  Non-Claude API keys (Fal, ElevenLabs, Higgsfield, OpenAI, …) are stripped by default
  so an overnight agent can't burn third-party credits; a card may re-add specific keys
  only if Angus set them in that project's `.ghosttype/env`.
- **`--ignore-scripts`** on every agent-triggered `npm install`/`ci` (blocks
  postinstall/prepare supply-chain execution). A card needing build scripts must
  declare it explicitly.
- **Native in-process caps:** every `claude -p` invocation also carries `--max-turns`
  and `--max-budget-usd` sized from the card — a free safety net *underneath* the
  Governor's own accounting.
- **Untrusted-blob discipline:** diff excerpts, test-output tails, transcript tails,
  and `NIGHT_NOTES.md` are each truncated to a fixed byte ceiling (~12 KB, truncation
  marked) before entering any prompt, and passed as fenced data-not-instructions.
- **Secret scrubber:** a stdlib-regex pass (`sk-…`, `ghp_…`, `AKIA…`, JWT shapes,
  `xox[baprs]-…`) strips credentials from any transcript/diff/notes text before it is
  sent to `claude -p` or written to disk.

## Components

Each is a separate module with one job, testable alone. Stack: Node 26 ESM, zero
runtime dependencies (stdlib + shelling to `git`/`tmux`/`claude`), state in
`~/.ghosttype/`, tests via `node --test`. Matches the idiom of `~/Tools/codex-bridge`.
Architecture note: we shell to the `claude` binary and parse its NDJSON by hand rather
than use the Agent SDK — a deliberate trade to keep zero runtime deps, accepting
hand-rolled stream parsing.

### 1. ghostd — the daemon

- launchd agent (absolute paths only) holding a `caffeinate -i` child while armed.
- **Power management is a first-class concern.** `ghost on` verifies AC power (refuses
  or loudly warns on battery), sets `pmset` to prevent lid-close/idle sleep while
  armed, and restores prior pmset state on `ghost off`. ghostd writes a **heartbeat**
  file every 2 min; `ghost status` and the morning report both detect heartbeat gaps
  and report *"machine slept 23:14–06:40, ghost idle"* as a distinct, named outcome —
  never silence. This is the #1 week-one death mode; it must be visible.
- States: `off` → `armed` → `running` → `paused` → `reporting`.
- **On-boot reconciliation:** after any unclean shutdown, detect orphaned clones/locks,
  park them with a note (or resume if `NIGHT_NOTES` + diff make it safe), and always
  leave every project ready for the next night. No wedged branches.
- **Human-priority rule (headless-correct):** while Angus is active (HIDIdleTime <
  60 s), ghostd does not *start* a new iteration or card; an in-flight headless session
  finishes or is killed cleanly. It never competes for the machine, but there's no live
  typing to interrupt in v1 (that's haunt mode, Phase 2).
- `ghost on "<send-off>"` arms; **`ghost on` with no send-off** falls back to
  continuing the highest-priority parked/most-recently-active project — never a no-op.
  **v1 requires explicit arming** — unattended execution never starts on its own.
  (Scheduled auto-arm is a Phase-2 opt-in with a visible schedule and an easy disable
  control, so the habit doesn't depend on a tired nightly command.)

### 2. Voice Profile Builder — `ghost learn`

- Reads `~/.claude/projects/**/*.jsonl`; extracts only *his* typed prompts (filter:
  `type=="user"`, `message.role=="user"`, string content; drops tool results, slash
  commands, pasted blobs). Runs the **secret scrubber** before anything leaves memory.
- The JSONL format is internal and version-unstable → tolerant parser, golden-file
  tests, skip-and-log on unknown shapes.
- **v1 is deliberately small** (the full-corpus map-reduce is a week-eater): a
  single-pass sample of his most recent ~200 user turns → one `claude -p` call →
  `voice-profile.md` + a **flat exemplar bank** (real prompts, each tagged with a
  situation via a fixed keyword/regex heuristic, hand-checked once). No embeddings, no
  clustering pipeline in v1.
- **`voice-profile.md` — the 9 named sections:** Summary · Directness & Tone · Sentence
  structure & length · Vocabulary / characteristic phrasings · Punctuation & formatting
  habits · Verification & "prove it" habits · Redirect-after-failure style · Judgment &
  priorities (what he tends to care about) · **What to Avoid** (mandatory anti-patterns).
- Situation tags: `kickoff · continue · redirect-after-failure · demand-verification ·
  unblock · wrap-up`.
- Rebuilt on demand (v1); weekly refresh later. Runs only while armed.
- **Honesty note — two distinct gaps, both surfaced in the report:**
  - *Style fidelity:* research ceiling for style imitation is real (~0.5 vs 0.76 human
    agreement). It steers like him; it won't be indistinguishable.
  - *Judgment fidelity:* his real prompts carry out-of-band knowledge the ghost can't
    have. The report grades prompts on **whether they showed the judgment he'd have**,
    not just whether they sounded like him.

### 3. Project Dossiers — `ghost scan`

Per repo: what it is, current state (RESUME.md / TODO / beads if present, git log +
status), the **detected test runner** (npm test / pytest / go test / cargo test / node
--test / a known verify script path), and what "progress" means. Cached JSON, refreshed
at arm time. This is what turns a vague send-off into real tasks.

### 4. Planner

At arm time: send-off + dossiers → **tonight's queue** of task cards.

```json
{ "project": "sitecraft",
  "goal": "…",
  "acceptanceArgv": ["npm", "test"],
  "acceptanceTimeoutSec": 600,
  "branch": "ghost/2026-08-21-gallery",
  "maxIterations": 6, "maxTurns": 40, "maxBudgetUsd": 4.0 }
```

- **v1 scope is narrow:** only the project(s) named in the send-off (no `~/dev`-wide
  auto-selection), at most 1–2 cards per arm. Depth over breadth.
- Story sizing (from ralph): one context window per story; if it can't be described in
  2–3 sentences, split it.
- **Acceptance is an argv array, never a shell string** (no injection of dossier-derived
  values), and it must match the runner the dossier already detected. A card whose
  acceptance command references an unavailable env var or a dead local service is
  **not queued** — it's reported as *"can't start: missing X"*, distinct from a card
  that failed after real work. No iterations wasted on guaranteed-stall cards.
- No acceptance command available → planned as a **proposal-only** card (writes a plan
  file, no code); a distinct report category that consumes no iteration/token budget.
- **Review backpressure:** the Planner tracks unmerged ghost branches per project and
  stops queuing new cards for a project once its unreviewed backlog crosses a threshold
  — surfaced as *"paused: N branches awaiting your review."* Supply can't outrun review.
- **Parked-card lifecycle:** parked cards from prior nights are first-class Planner
  candidates ("resume parked: X" vs "start fresh"); the reaper prunes their clones too.
- Queue persists to disk; survives daemon restart.

### 5. Runner

Per card: create the throwaway local clone + branch, spawn a **fresh** `claude -p`
(headless, `--output-format stream-json --verbose`) with the written prompt, child
process `cwd` set to the clone's absolute path (there is no `--cwd` flag for `-p`), the
`GHOST_SESSION` marker, the scoped allowlist, the hygienic env, and native
`--max-turns`/`--max-budget-usd`. One story per session. The session maintains
`NIGHT_NOTES.md` in the clone as the cross-iteration baton.

**`NIGHT_NOTES.md` fixed format** (seeded into the session's prompt): four required
headings — *What I tried · Current state · What's blocking · What's next*. Capped size;
the Prompt Writer compresses it before each new iteration.

### 6. Watcher

Headless sessions give mostly clean signals: process exit + stream-json `result` event.
Four distinct, never-conflated end-states:

- **done-claimed** → hand to Verifier.
- **stalled/errored** → Prompt Writer.
- **rate-limited** → parsed from the `result` **text** (subscription/weekly/Opus
  exhaustion is a message, not a structured field — hence the separately-tested
  reset-time parser). Sleep until reset; never prompt into a dead window.
- **network-unreachable** → short backoff-and-retry (not a new prompt, not a long
  sleep); escalate to stalled only after retries fail.

Token spend from `result` usage fields → Governor. (Haunt mode's pane-ownership +
idle state machine is Phase 2.)

### 7. Verifier — trust nothing the agent says

- Runs the card's `acceptanceArgv` **itself**, in the clone, as an argv spawn. Pass =
  exit 0 within `acceptanceTimeoutSec`; timeout or nonzero = fail. The agent's "done"
  claim is never sufficient — a different instrument grades the work.
- **Diff sanity check:** a cheap `claude -p` judge gets goal + `git diff --stat` + a
  truncated, fenced, shield-scanned diff excerpt (same helper the Prompt Writer uses —
  built once, not twice) and answers one question: *implemented, or deleted/gutted?*
  Plus a non-LLM cross-check that can't be argued out of its answer: flag if the diff is
  net-negative lines against a "build a feature" goal. **Fail-closed** — anything other
  than a clear "implemented" is a fail (park + report).
- Pass → commit in the clone, mark card done, next card. Fail → failure context to
  Prompt Writer.

### 8. Prompt Writer — the heart

Input: task card + clone state (fenced/truncated/scrubbed diff, test-output tail) +
session transcript tail + `NIGHT_NOTES` + voice profile + 3–5 exemplars. Output: the
next prompt, as Angus would type it. Implementation: one `claude -p` call (Sonnet
default; model configurable).

- **Exemplar matching is tag-equality** (situation tag → most recent N exemplars),
  additionally filtered by project/domain when a domain match exists, falling back to
  situation-only. No embeddings, no new dependency.
- **Escalation ladder:** *failure-equality* = same acceptance exit code + same first
  ~5 lines of stderr (or same Verifier failure category). Same failure twice → force an
  approach change ("stop, revert that file, try X"). Third strike → park the card, write
  it up, move on. No all-night loops on one broken migration.
- **Injection posture (corrected):** the Prompt Writer is *not* the defense layer — the
  tool-call controls in "Foundational safety" are. Here: all untrusted inputs are
  fenced/truncated/scrubbed; the shield scan (multi-language signal-word list, run over
  transcript tail *and* `NIGHT_NOTES`) is **gating, not cosmetic** — a hit routes the
  card straight to third-strike park, not a report footnote. The output lint
  (push/deploy/rm-rf/exfil wording) stays as a cheap sanity check but is explicitly
  **not** relied on as security — wording filters are trivially reworded around.

### 9. Governor — hard limits, all enforced by code

| Limit | Default |
|---|---|
| Iterations per card | 6 |
| Wall clock **per card (total)** | 45 min |
| **Total night wall clock** | until 07:00, checked between cards |
| Claude tokens per night | hardcoded conservative default (~2M), config-overridable |
| Third-party $ per night | keys stripped by default; if allowlisted, a nightly $ cap |
| Consecutive engine errors | 3 → circuit breaker, park card |
| Disk | clone refused under 20 GB free, **checked before every clone**; reaper runs at arm start, prunes done/declined/parked clones |

**One shared token-accounting wrapper** meters *every* `claude -p` call in the system —
Runner, Prompt Writer, Verifier diff-judge, Voice Builder — against the same nightly
counter, checked **before** each call fires. Native `--max-budget-usd` per call backs it
up in-process. Any night-level cap trip → stop cleanly, write report, disarm.

### 10. Morning report

Pushed, not just pulled: a macOS notification on disarm / at a set morning hour with a
one-line verdict (*"3 shipped, 1 parked, review 2 branches"*) that deep-links the
report. Report itself is **markdown-first in v1** (HTML wrapper added once the loop is
trustworthy), written to `~/dev/pages/ghost-type/` and `open`ed.

Layout respects "show, don't wall-of-prose": a **one-glance status strip first** — card
· merge-ready? · one-line why, in columns — then collapsible per-card detail (goal,
outcome, iterations, **actual test output**, branch, parked-why, full diff/prompts
folded). Plus: every prompt the ghost wrote with 👍/👎 (graded on *judgment*, not just
style), tokens/$ spent, machine-slept gaps, and anything the shield flagged. A 👎 on an
exemplar down-weights it on the next `ghost learn` (minimal feedback loop present in v1
so grading visibly matters).

### 11. CLI

`ghost on "…"` · `ghost off` · `ghost status` · `ghost queue` · `ghost report` ·
`ghost learn` · `ghost scan`. Low-friction re-arm path (Shortcut / one-tap) noted for
later. Menu bar app: later, not v1.

## Data flow

```
arm ▶ pmset+AC+heartbeat ▶ scan ▶ plan ▶ queue
        ┌──────────────◀───────────────────┐
        ▼                                   │
  next card ▶ local clone (origin removed) ▶ fresh claude -p
        │        (GHOST_SESSION, scoped tools, clean env)
     watcher ── rate-limited ─ sleep→reset
        │     └─ network-down ─ backoff
     done-claimed ▶ VERIFIER (runs tests itself) ── pass ▶ commit ▶ next card
        │                        └─ fail ┐
     stalled ───────────────────▶ PROMPT WRITER (voice) ▶ new session
                                    └─ 3rd strike / shield hit ▶ park card
queue empty / cap hit / 07:00 ▶ report + push notification ▶ disarm
```

## Error handling

Every component fails **soft toward "park and report", never "keep burning"**: parser
drift → skip + log; engine crash → one retry → park; unknown watcher state → do nothing
+ report; unclean shutdown → on-boot reconciliation; report writer itself failing →
plain-text dump to `~/.ghosttype/log`.

## Testing

- Unit: transcript parser (golden JSONL fixtures, current + mutated shapes), reset-time
  parser, secret scrubber, shield, output lint, governor accounting, env-allowlist
  builder.
- **Loop e2e with a fake engine:** a stub `claude` script emits scripted stream-json
  (done / stall / rate-limit / network-down / hostile-injection cases) and drives the
  whole daemon through a simulated night without spending a token.
- **dcg canary:** the live-smoke test runs one throwaway `claude -p` that attempts an
  action dcg/guard.py is known to block, and **fails the build** if it isn't blocked —
  so a future Claude Code change that stops applying hooks can't silently remove the net.
- Live smoke: one real card against a scratch repo with a deliberately failing test;
  assert iterate → verify → commit → report.
- Voice: blind side-by-side eval — 20 held-out real situations, ghost prompt vs his
  actual next prompt, graded on style *and* judgment.

## Build order (spine-first over risk, not spec order)

- **Milestone 0 — the spine, before any daemon/CLI/voice:** one hand-written JSON card
  (project, goal, acceptanceArgv) → local clone → `claude -p` with a canned prompt →
  Watcher → Verifier runs the test → commit → markdown report. This alone validates the
  whole thesis on one project in one night. Built with the fake engine first, then one
  live card.
- **M1:** Governor + escalation ladder + Prompt Writer (canned voice, then real).
- **M2:** Voice Builder (sampled) + exemplars.
- **M3:** ghostd (launchd, pmset, heartbeat, reconciliation) + Planner + dossiers + CLI.
- **M4:** report polish (HTML, push notification, grading feedback).

## v1 scope vs later

**v1:** everything above — spine, governor, prompt writer, sampled voice, planner
(named-project, 1–2 cards), daemon, markdown+push report.
**Phase 2:** haunt mode (tmux injection into live sessions), Codex engine, full-corpus
voice with clustering, Headroom quota integration, auto-arm, menu bar app.
**Not planned:** cloud routines, multi-machine fleet.
