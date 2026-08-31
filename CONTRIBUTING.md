# Contributing

Ghost Type is built **spine-first, test-first, zero-dependency**. A few house rules keep
it that way.

## Ground rules

- **No runtime dependencies.** Standard library plus shelling to `git` and `claude`. If
  you think you need a dependency, open an issue first — the answer is usually "you don't".
- **Node ≥ 26, ESM only** (`.mjs`, `import`/`export`).
- **Tests are the spec.** Every module has a `test/<name>.test.mjs`. Write the failing
  test first, watch it fail, then make it pass. The whole suite runs offline via
  `node --test` against `test/fake-claude.mjs` — it must never spend a token or need the
  network.
- **Safety is not negotiable.** Anything that spawns an agent must keep the invariants in
  the [design spec](docs/superpowers/specs/): isolated clone, `origin` removed, env
  stripped of non-Claude keys, untrusted text scrubbed + fenced + shield-scanned.

## Running the tests

```bash
node --test              # everything, offline
node --test test/watcher.test.mjs   # a single file
```

## Before you open a PR

- `node --test` is green.
- New behavior has a test that would fail without your change.
- No new dependency slipped into `package.json`.
- Comments explain *why*, never *what*.

## Where things live

- `src/` — one module, one job. Keep files small.
- `test/` — one test file per module + the offline `fake-claude.mjs` engine.
- `docs/superpowers/specs/` — the design. Read it before changing agent-facing behavior.
- `docs/superpowers/plans/` — the per-milestone implementation plans.

## Outside contributions

See the "About contributions" note at the end of the README — issues and bug reports
welcome; PRs are reviewed by an agent and re-implemented rather than merged directly.
