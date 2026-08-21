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

## The one partial guard, stated plainly

**Acceptance tests execute code the agent may have modified.** That is unavoidable — verifying
by running the test *is the point*. Ghost Type contains this rather than eliminating it:

- the test runs in the **isolated clone** (writes land there, not the source repo),
- with a **credential-stripped environment** (no API keys of any provider),
- in its **own process group** that the timeout tears down wholesale.

What it does **not** yet do is run the test inside a full OS sandbox restricting filesystem
reads and network. A malicious test could still read files outside the clone (e.g. `~/.ssh`)
or make network calls. This is a deliberate scope decision: the intended threat model is *your
own repositories running their own tests*, and a strict `sandbox-exec` fs/network jail reliably
breaks legitimate test suites. If you run Ghost Type against **untrusted** repositories, run the
daemon as a dedicated low-privilege user or inside a VM/container.

## Reporting

This is a personal project; open an issue on the repository for anything security-relevant.
