# Security model

Ghost Type runs coding agents unattended, overnight, on your machine. That is inherently a
position of trust, so the design assumes things *will* go wrong and contains the blast radius.
This document is the honest threat model — what's guarded, how, and the one place the guard is
partial by design.

## What Ghost Type defends against

| Threat | Guarantee | Where |
|---|---|---|
| Wrecking the real repo | Work happens in an **isolated `git clone --local --no-hardlinks`** — even the object store is a separate copy, so a modified/chmod'd clone object can't corrupt the source. | `clone.mjs` |
| Pushing while you sleep | The clone's **`origin` remote is removed** first — push/gh/deploy have nowhere to go. The real repo is only ever a *fetch* destination. | `clone.mjs` |
| A runaway bill | A hard **dollar cap** and **token cap**, plus a **07:00 deadline**, metered before *and* bounded *into* every engine call (a call can't overspend the remaining nightly budget). Native `--max-budget-usd` on top. | `governor.mjs`, `spine.mjs` |
| A single call hanging forever / OOM | Each engine call runs under a **wall-clock deadline that kills the whole process group**, and streams into **byte-capped head+tail buffers**. | `engine.mjs` |
| Prompt injection from a transcript | Every untrusted input (diffs, test output, transcripts) is **secret-scrubbed, byte-capped, and fenced** as data-not-instructions, with a shield scan that parks the card on a hit. Forged fence boundaries are defanged. | `sanitize.mjs`, `prompt-writer.mjs` |
| Leaking secrets into a prompt/log | Broad secret patterns (API keys, PEM private-key **blocks**, all GitHub token formats, Stripe keys, JWTs) are redacted before any text reaches a prompt. | `sanitize.mjs` |
| Cross-provider credential leak | A session receives **only the selected engine's** provider credentials — a Codex run never sees Anthropic keys, nor a Claude run OpenAI's. Acceptance tests get **zero** provider credentials. | `env.mjs` |
| "Passing" by deleting the feature | Verification runs the acceptance test *itself* (the agent's "done" is never trusted) and refuses a diff that **guts a file, deletes a test, or is net-negative** for a build goal. | `verifier.mjs` |
| Silent death (asleep/on battery/no disk) | Refuses to arm on battery, low disk, or an **unreadable** power/disk probe (fail-closed); a heartbeat makes "the machine slept, the ghost never ran" a visible outcome. | `daemon.mjs` |
| Destroying crashed work on restart | An existing same-name clone is **quarantined**, not deleted; orphaned clones are preserved across a re-arm. | `clone.mjs`, `daemon.mjs` |
| Recursive delete escaping the state dir | The reaper and cloner refuse a symlinked work root **or any symlinked ancestor within HOME**, and every clone path is realpath-overlap-checked. | `clone.mjs`, `daemon.mjs` |
| Typing over you / into a shell (haunt mode) | Injection is fail-closed: only into a **confirmed** agent pane, never while you're at the keyboard, never a blind Enter; text is re-guarded after the pause and cleared from a shell if the agent exited mid-inject. | `drive.mjs` |

## The `sandbox` flag — for untrusted repositories

Both the coding session and the acceptance test execute code the agent may have influenced. On
your **own** repositories that's benign; against **untrusted** ones it's a risk. Two things
contain it regardless: the coding agent has **no arbitrary shell** (its Bash grant is only the
detected test runner + non-pushing git), and all work happens in the **isolated clone**. Set
`"sandbox": true` in `~/.ghosttype/config.json` to add an OS-level jail (macOS `sandbox-exec`):

- **coding session** — network stays up (the provider API needs it), but **writes are confined
  to the clone** (+ the agent's own state dirs). It cannot edit `~/.zshrc`, `~/.ssh`, or system
  files. *(verified: an external write returns `EPERM`, a clone write succeeds, network works.)*
- **acceptance test** — **network is denied** (the exfiltration path) and writes to credential
  stores are blocked. *(verified: a network connect fails under the jail, succeeds without it.)*

It's **off by default** because a network-denied test jail and a write-confined coding session
break work that legitimately needs the network or writes outside the clone. It's a no-op off
macOS; there, or for stronger isolation, run the daemon as a dedicated low-privilege user or
inside a VM/container.

## The acceptance test is the oracle

Verification runs the project's own acceptance command and trusts its exit code. Two guards
keep a rigged test from shipping junk: the candidate's **full tree is frozen** (tracked +
untracked, `.gitignore`-respecting) before the test runs and any change to it is refused — so a
test that erases or rewrites its own patch to fake a pass is caught — and a **destructive-diff
guard** refuses net-negative / test-deleting changes.

What no diff guard can catch is an agent that **weakens the oracle itself** — editing a test's
assertions or a `package.json` test script so the check passes trivially. On your **own** repos
that's ordinary test-driven development, not an attack. On **untrusted** repos, the `sandbox`
flag and these guards narrow it, but a protected/immutable oracle (or a human-reviewed test
diff) is the only complete answer — treat the morning report's diff as the real gate.

## Cost governance is Claude-specific

The hard **dollar** cap is enforced for Claude (via `--max-budget-usd` + metered `total_cost_usd`).
The installed Codex CLI exposes no native dollar-budget flag and reports no per-turn cost, so
Codex cards are bounded by the **token cap**, the **07:00 deadline**, and the consecutive-error
breaker — not by dollars. If you need a hard dollar ceiling on Codex spend, route it through a
budget-enforcing proxy or keep Codex cards off dollar-critical nights.

## Reporting

This is a personal project; open an issue on the repository for anything security-relevant.
