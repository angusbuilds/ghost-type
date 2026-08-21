# Security

Ghost Type runs coding agents **unattended, with elevated permission, inside clones of
real repositories**, and it composes the prompts those agents run from text that may be
attacker-influenced (repo files, dependency output, transcripts of things the agent read
on the web). Security is therefore a first-class design concern, not an afterthought.

## The threat model

Assume every input Ghost Type reads is attacker-reachable. Defenses live at the
**tool-call layer**, not in prompt wording, and the system fails toward *"park and
report"*, never toward *"keep going."*

## Controls in place

| Risk | Control |
|---|---|
| Escaping into the real repo | Every task runs in an isolated `git clone --local`; the path is validated to be under `~/.ghosttype/work/` before any work begins |
| Pushing / deploying unattended | The clone's `origin` remote is removed; the tool allowlist excludes `push`/`gh`/`curl`/deploy |
| Spending third-party money | Non-Claude API keys are stripped from the session environment by default |
| Runaway cost | Native `--max-budget-usd` per session + a nightly token cap + a hard wall-clock deadline |
| Prompt injection via transcripts/diffs | Untrusted text is secret-scrubbed, byte-capped, and fenced as data-not-instructions; a shield scan for injection signal phrases **parks the card** rather than passing the payload forward |
| Credential leakage into the model or logs | A regex secret-scrubber runs over any transcript/diff/notes text before it enters a prompt or is written to disk |
| The guardrails silently stopping applying | A **dcg canary** release gate fires a `claude -p` session that *tries* a blocked action; if it isn't blocked, the tool refuses to arm |

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or email the maintainer.
Do not file a public issue for an exploitable vulnerability until it has been addressed.
