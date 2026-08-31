# Decision needed: should the menu bar actually *drive*, or only *haunt*?

## Resolved — 2026-08-30

**Option A** shipped: a goal field, not B's "drive toward the armed send-off." One
refinement — the field lives in a small borderless key `NSPanel` flush under the status
item, not inside the tracking `NSMenu`: menus eat keystrokes for item navigation, a key
panel types reliably. "Driving" in the UI is now backed by `src/drives.mjs`, a
ps-verified registry of live drive processes, so the label this doc complained about is
now truthful — for CLI-started drives too, and across app restarts. The CLI grew
`ghost drives [--json]` (what the menu bar polls) and `ghost undrive <pane>`. Every item in
the "When picked, the work is" list below is built and the full suite is green (the README badge carries the count) — including
the final bullet, the live smoke: verified 2026-08-30 against a real tmux pane and the
running app, driven end-to-end through the Accessibility API (real clicks, real
keystrokes). Confirmed live: a CLI-started drive shows as "driving" in the dropdown and
the menu-bar title with zero app involvement; clicking the driving row SIGINTs it (tint
and registry clear); clicking an idle row opens the goal panel, typed text lands, Return
spawns a detached drive whose parent is the app; quit stops app-spawned drives and leaves
CLI-started ones running. See docs/live-smoke.md § menu-bar drive.

This is the one genuinely-open item from the whole audit campaign (round 28 "#1").
It needs a product call, not just wiring — so it's written up here rather than guessed.

## The gap, precisely

| Action | What it does today | Where |
|---|---|---|
| `ghost haunt <pane>` | tints the pane purple + records it in `haunted.json` | menu-bar click → `toggle()` |
| `ghost drive <pane> "<goal>"` | the real loop: watches the pane, injects the next prompt when the agent idles | **CLI only** |

The menu bar calls **haunt**, never **drive**. So clicking a session turns it purple but
nothing is injected. The panel label says "sessions driving" — which overstates what a
haunt-only pane is doing. `drive` (the loop that does the work) is reachable only from the
terminal, and it needs a **goal** the menu bar never collects.

## Why it isn't just wiring

`drive` needs three things the menu bar doesn't have:

1. **A goal.** Driving means "keep this session moving toward X." Where does X come from?
2. **A long-running process.** `hauntDrive` polls for minutes/hours. It can't run on the UI
   thread — it must be spawned **detached**, tracked, and stopped on unhaunt.
3. **Lifecycle.** Start on select, stop on deselect/quit, survive a popover close.

## Three viable designs

| Option | Goal source | UX | Cost | Risk |
|---|---|---|---|---|
| **A — goal sheet** | a text field shown when you pick a session | click → type goal → it drives | med Swift UI | can't auto-verify a GUI |
| **B — drive toward the armed send-off** | the daemon's current send-off line | click → drives toward tonight's goal | small | only works while armed |
| **C — relabel, keep CLI-only** | n/a | menu bar = "mark/watch"; driving stays `ghost drive` | tiny | leaves the gap open |

## Recommendation

**B, then A.** Option B is the smallest honest step: if a send-off is armed, one click
drives the picked pane toward it; if nothing is armed, the click just haunts (today's
behavior) and the row says "haunted", not "driving". A later text-field (A) adds per-pane
goals. C alone is a cop-out — it keeps the label honest but never closes the gap.

## Why this is deferred (not done in the loop)

The fix is **Swift menu-bar UI + a detached process**, and a GUI feature can't be verified
end-to-end in an autonomous run — it needs a human at the menu bar, real tmux panes, and
real agent sessions spending real tokens. Shipping unverifiable UI code would be a false
"done". The **engine it will call (`src/drive.mjs`) is separately hardened and tested** —
so whichever option is chosen, the dangerous part (typing into live terminals) is already
proven. What remains is a UI decision that's Angus's to make.

## When picked, the work is

- Swift: add the goal affordance (B: read armed send-off from `state.json`; A: a text field).
- Swift: spawn `ghost drive <pane> "<goal>"` **detached** (`Process` without `waitUntilExit`),
  hold onto the `Process` and `terminate()` it directly on quit. **Not what shipped:**
  `terminate()` would `SIGTERM` the drive and strand its tint + registry entry; the app
  instead shells out to `ghost undrive <pane> --pid <p>` (`SIGINT`, handled by the drive's
  own cleanup). The pid the app remembers is used only as a safety check, never to signal
  the process directly — `ghost undrive` refuses to touch a pane unless the registry still
  names that exact pid as the live drive there — see `Model.swift`'s
  `startDrive`/`undrive`/`undriveBlocking`.
- Relabel the row/panel: "driving" only when a drive process is actually live for that pane.
- Verify manually against the `docs/live-smoke.md` gate (real pane, real session).
