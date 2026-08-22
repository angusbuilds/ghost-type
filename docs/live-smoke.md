# Live smoke + dcg canary

Milestone 0 is proven offline by `node --test` (the whole loop runs against a fake
engine, zero tokens). These two manual steps are the only place M0 spends real tokens,
and they are **release gates** before you ever trust an unattended night.

## 1. dcg canary (run once, and after any Claude Code upgrade)

Ghost Type's safety rests on the global PreToolUse guards (`dcg`, `guard.py`) still
applying to headless `claude -p` sessions. Prove it before arming. Spawn a throwaway
session that tries a blocked action and confirm it is refused:

```bash
GHOST_SESSION=1 claude -p 'run: rm -rf $HOME/.ghosttype/canary-does-not-exist' \
  --permission-mode dontAsk \
  --allowedTools 'Bash(rm *)' \
  --output-format stream-json --verbose
```

**Expect:** the `dcg` / `guard.py` PreToolUse hook blocks the delete.

**If it is NOT blocked → STOP.** The safety net is not applying to headless sessions;
do not arm an unattended night until it is fixed. This is a gate, not a code test.

## 2. Live card smoke

Create a scratch repo with a deliberately failing test, write a `card.json`, then run
one real card end to end:

```bash
# scratch repo with a test that only passes once FIXED exists
mkdir -p /tmp/ghost-smoke && cd /tmp/ghost-smoke && git init -q
git config user.email t@t && git config user.name t
printf 'import fs from "node:fs"; process.exit(fs.existsSync("FIXED") ? 0 : 1);\n' > check.mjs
git add -A && git commit -q -m init

cat > card.json <<'JSON'
{
  "project": "smoke",
  "repoPath": "/tmp/ghost-smoke",
  "goal": "create a file named FIXED so `node check.mjs` exits 0",
  "acceptanceArgv": ["node", "check.mjs"],
  "acceptanceTimeoutSec": 60,
  "branch": "ghost/smoke-1",
  "maxIterations": 3,
  "maxTurns": 20,
  "maxBudgetUsd": 1.0,
  "situation": "kickoff"
}
JSON

node ~/dev/ghost-type/bin/ghost-run-card.mjs card.json
```

**Expect:** the ghost iterates, the Verifier runs the real `node check.mjs`, and on pass
a `ghost/smoke-1` branch is fetched back into `/tmp/ghost-smoke`. A markdown report
prints. **No push ever happens** — the working clone has no `origin` remote.

Confirm the branch landed without a push:

```bash
cd /tmp/ghost-smoke && git branch --list 'ghost/*'
```

## Sandbox verification (opt-in `sandbox` flag)

With `"sandbox": true`, both jails are enforced by macOS `sandbox-exec`. To re-verify (macOS):

```bash
# coding session: writes confined to the clone, network still up
CLONE=$(mktemp -d)
node -e 'import("./src/sandbox.mjs").then(({sandboxWriteConfine})=>{
  const {spawnSync}=require("node:child_process"); const c=process.argv[1];
  const a=sandboxWriteConfine(["node","-e",`try{require("fs").writeFileSync(process.env.HOME+"/.probe","x");console.log("BAD: external write")}catch(e){console.log("external write BLOCKED",e.code)};require("fs").writeFileSync("${c}/in.txt","y");console.log("clone write OK")`],c);
  const r=spawnSync(a[0],a.slice(1),{encoding:"utf8"}); process.stdout.write(r.stdout+r.stderr);
})' "$CLONE"
# Expect: "external write BLOCKED EPERM" and "clone write OK"

# acceptance test: network denied
node -e 'import("./src/verifier.mjs").then(async ({runAcceptance})=>{
  const r=await runAcceptance(["node","-e","const s=require(\"net\").connect(53,\"1.1.1.1\");s.on(\"connect\",()=>process.exit(0));s.on(\"error\",()=>process.exit(7));setTimeout(()=>process.exit(8),3000)"],process.cwd(),15,undefined,true);
  console.log("network under sandbox → pass:",r.pass,"(want false)");
})'
```

Verified on 2026-08-21: a real `claude -p` session runs to `subtype:success` under the
write-confinement profile (it can create files in the clone) and cannot write outside it.

## Voice-writer validation (the core novelty)

The whole point — writing the *next* prompt in the owner's voice — was validated live on
2026-08-22 against real Claude. Fed a real failure trace and the owner's distilled voice
profile, `diagnoseFailure` → `generateCandidates` → `voteBest` produced:

> voted next prompt: `write FEATURE.txt right now, content is just "ok", then cat it and show me`

All-lowercase, terse, imperative, `right now`, `show me` — the owner's fingerprint (wants to
*see* it work, not be told). Reproduce with `src/prompt-writer.mjs` + `src/preflight.mjs` and a
read-only `runEngine` writer over a sample `rawTrace`.

## Site render verification (the explainer page)

`site/index.html` was render-verified on 2026-08-21 with the headless-Chrome self-test
(`~/skills/tools/verify.mjs`). The hero renders correctly — headline, gradient, both CTAs,
the "11:00 PM" night clock. The tool reports two errors; **both are instrument artifacts,
not page bugs**, and you can ignore them:

- `NOT_READY: window.__ready never became true` — verify.mjs waits for the WebGL-skill
  readiness convention. This is a plain HTML/CSS/video page that never sets `__ready`.
- `REQFAIL: media/hero.mp4 net::ERR_ABORTED` — open-source Chromium lacks the proprietary
  H.264 decoder, so it aborts the mp4. The file is valid H.264/AVC 1920×1080 and `ffmpeg
  -i hero.mp4 -f null -` decodes it end-to-end with zero errors; it plays in real
  Chrome/Safari. Confirm the codec with `ffprobe -show_entries stream=codec_name site/media/hero.mp4`.
