import AppKit
import SwiftUI

// Typing inside a tracking NSMenu is a known AppKit dead end — menu tracking eats
// keystrokes for item navigation, and Headroom only ever proved *buttons* in a menu, never
// a field. So the goal field lives in its own small borderless panel instead: reliable
// focus, a fixed height regardless of what's typed, gone on Return, Esc, or click-away.
final class KeyPanel: NSPanel {
    // Borderless panels don't become key by default; without this the field never gets
    // real keyboard focus and every keystroke is silently dropped.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// Headroom's OAuthCodeField pattern, extended to the whole clipboard family: an accessory
// app installs no real menu bar, so nothing wires Cmd-V/C/X/A to the field editor unless
// this does it directly.
final class GoalTextField: NSTextField {
    var onCancel: (() -> Void)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if modifiers == .command, let chars = event.charactersIgnoringModifiers {
            switch chars {
            case "v": currentEditor()?.paste(nil); return true
            case "c": currentEditor()?.copy(nil); return true
            case "x": currentEditor()?.cut(nil); return true
            case "a": currentEditor()?.selectAll(nil); return true
            default: break
            }
        }
        return super.performKeyEquivalent(with: event)
    }

    // Escape climbs the responder chain from the field editor to here — the standard
    // AppKit route for a field's own Escape-to-cancel (same one NSSearchField uses).
    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}

// Owns the panel's whole lifecycle: one goal field, positioned flush under the status
// item, torn down the moment it stops being useful (submit, cancel, or losing key focus).
final class GoalPanelController: NSObject {
    private var panel: KeyPanel?
    private var field: GoalTextField?
    private var caption: NSTextField?
    private var paneId: String?
    // Whatever app was frontmost before we activated for keystrokes — restored in dismiss()
    // so the terminal being driven doesn't lose focus for the rest of the session.
    private var previousApp: NSRunningApplication?
    // Guards against a second Return firing a second startDrive while the first launch is
    // still in flight — the panel now stays open until the result is known (see submit()),
    // so a double-submit is reachable in a way it wasn't when dismiss() was unconditional.
    private var submitting = false
    // This controller is a single shared instance reused for every session, not one per
    // submission — `panel`/`field`/`caption`/`paneId`/`submitting` are all mutable state a
    // LATER show()/dismiss() can repurpose out from under an EARLIER submit()'s still-pending
    // startDrive completion. Bumped every time dismiss() actually tears down a live panel;
    // submit() snapshots the value at launch time and a completion closure that finds the
    // generation has since moved on knows it belongs to a panel this instance is no longer
    // showing, and must not touch the shared UI state or dismiss the panel now open for
    // someone else (round-40 audit #2/#4).
    private var generation = 0
    private let model: GhostModel
    // Fires the instant the child process exists, so the app can register it as its own
    // before waiting to learn whether the drive actually took (round-39 audit #1).
    private let onLaunched: (String, Int32) -> Void
    private let onSpawned: () -> Void

    init(model: GhostModel, onLaunched: @escaping (String, Int32) -> Void, onSpawned: @escaping () -> Void) {
        self.model = model
        self.onLaunched = onLaunched
        self.onSpawned = onSpawned
    }

    func show(for session: Session, near button: NSStatusBarButton) {
        dismiss()
        paneId = session.paneId

        let width: CGFloat = 300
        let height: CGFloat = 70
        let panel = KeyPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false

        // The panel's own background is clear; a bare NSPanel has no vibrancy of its own,
        // so the shared VisualEffect view (main.swift) supplies the frosted material —
        // hosted as one full-bleed background layer, with the AppKit field on top of it.
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        let effectHost = NSHostingView(
            rootView: VisualEffect(material: .menu)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        )
        effectHost.frame = container.bounds
        effectHost.autoresizingMask = [.width, .height]
        container.addSubview(effectHost)

        // Persistent, unlike the placeholder below: an NSTextField placeholder vanishes on
        // the first keystroke, which otherwise leaves the user with zero on-screen
        // confirmation of which live pane is about to receive keystrokes for as long as
        // they're typing (round-36 audit #3/#19). Shows the human label actually clicked in
        // the dropdown, not the internal tmux id the placeholder below still names.
        let caption = NSTextField(labelWithString: "→ \(session.target)")
        caption.font = .systemFont(ofSize: 11, weight: .medium)
        caption.textColor = .labelColor.withAlphaComponent(0.48)
        caption.frame = NSRect(x: 14, y: 42, width: width - 28, height: 16)
        container.addSubview(caption)
        self.caption = caption

        let field = GoalTextField(frame: NSRect(x: 14, y: 14, width: width - 28, height: 22))
        // Names the pane, not the friendly label — %3 is what `ghost undrive` takes too.
        field.placeholderString = "goal for \(session.paneId) — return drives, esc cancels"
        field.font = .monospacedSystemFont(ofSize: 12.5, weight: .medium)
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.target = self
        field.action = #selector(submit(_:))
        field.onCancel = { [weak self] in self?.dismiss() }
        container.addSubview(field)

        panel.contentView = container
        self.panel = panel
        self.field = field

        // Flush under the status button, the same welded-on placement as the dropdown.
        if let buttonWindow = button.window {
            let onScreen = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
            panel.setFrameOrigin(NSPoint(x: onScreen.minX, y: onScreen.minY - height))
        }

        // Click-away dismissal: the panel is nonactivating, so losing key status is the
        // only signal that the user's attention has moved elsewhere.
        NotificationCenter.default.addObserver(
            self, selector: #selector(panelResignedKey(_:)),
            name: NSWindow.didResignKeyNotification, object: panel
        )

        panel.initialFirstResponder = field
        // An accessory app gets no focus for free — without this the panel opens behind
        // whatever window was frontmost and typing goes nowhere. KeyPanel is already
        // .nonactivatingPanel + canBecomeKey, AppKit's own mechanism for a panel to take
        // keystrokes WITHOUT activating us — activating anyway is what steals focus from
        // the terminal being driven, so capture it here and hand it back in dismiss()
        // (round-36 audit #7).
        previousApp = NSWorkspace.shared.frontmostApplication
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
    }

    // restoreFocus is false only for the click-away path (panelResignedKey): the user just
    // chose to move focus to another app (Safari, Finder, ...) by clicking into it, and
    // reactivating previousApp over that fights the user's own action instead of following
    // it. submit() and Escape both still restore focus — those are genuine "I'm done with
    // the panel" moments, not the user moving on elsewhere (round-36 audit follow-up).
    func dismiss(restoreFocus: Bool = true) {
        guard let panel else { return }
        // Escape and click-away tore this down unconditionally, even mid-submission — the
        // already-spawned drive kept running into the tmux pane with no error, no reopened
        // panel, no log line, and nothing on screen to say it had happened, contradicting the
        // field's own "esc cancels" placeholder and the "stays open until the result is known"
        // comment on submit() below (round-42 audit #3). Best-effort, fire-and-forget, same
        // paneId-only call selected() already uses for a confirmed-driving row — if the child
        // hasn't spawned yet this can race ahead of its own claimDrive registration and miss
        // it, but onLaunched below is deliberately not gated on `generation`, so a launch that
        // slips past this cancel still lands in main.swift's pid-verified appSpawnedPaneIds and
        // remains reachable there (periodic prune, or Quit) — this is a best-effort immediate
        // stop, not the only backstop.
        if submitting, let targetPane = paneId {
            model.undrive(targetPane)
        }
        NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: panel)
        panel.orderOut(nil)
        self.panel = nil
        self.field = nil
        self.caption = nil
        self.paneId = nil
        self.submitting = false
        generation += 1   // invalidate any in-flight startDrive completion captured against this panel instance
        if restoreFocus, let previousApp {
            if #available(macOS 14.0, *) { previousApp.activate() } else { previousApp.activate(options: []) }
        }
        previousApp = nil
    }

    @objc private func panelResignedKey(_ note: Notification) {
        dismiss(restoreFocus: false)
    }

    @objc private func submit(_ sender: Any?) {
        guard !submitting, let pid = paneId, let text = field?.stringValue else { return }
        let goal = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty else { return }   // ignore empty submit — leave the panel open
        // Dismissing here unconditionally, before the launch's outcome was known, made a
        // failed drive completely invisible: the panel just vanished as if it had started,
        // with no error text, no reopened panel, no log line (round-39 audit #2). The panel
        // now stays open (caption reused as a status line) until startDrive settles — closed
        // only on success — so a failure has somewhere to say what happened and the goal
        // text is still there to retry.
        submitting = true
        caption?.textColor = .labelColor.withAlphaComponent(0.48)
        caption?.stringValue = "starting…"
        // Snapshot the generation this submission belongs to — see the `generation` doc
        // comment. Checked in the completion below before touching any shared UI state.
        let myGeneration = generation
        model.startDrive(paneId: pid, goal: goal, onLaunched: { [weak self] launchedPid in
            // Fires as soon as the child exists, independent of whether startDrive's own
            // completion below ultimately reports success or a fast failure — registering
            // this early is what closes the Quit race (round-39 audit #1); a launch that
            // turns out to fail is harmlessly pruned later (see Model.swift's onLaunched doc).
            // Deliberately NOT gated on `generation`: this registers the spawned pid for the
            // app's own cleanup tracking regardless of whether the panel that requested it is
            // still showing, and skipping it here would reopen the exact Quit race above.
            self?.onLaunched(pid, launchedPid)
        }) { [weak self] started, spawnedPid, errText in
            guard let self else { return }
            // A stale completion — this panel has since been dismissed or repurposed for a
            // different session (dismiss() bumps `generation`) — must not clobber `submitting`
            // for whatever submission is current now, nor dismiss or paint an error onto
            // whatever panel is currently showing (round-40 audit #2/#4).
            let isCurrent = self.generation == myGeneration
            if isCurrent { self.submitting = false }
            if started {
                // The drive genuinely started, whether or not this panel is still the one
                // showing — always tell the app to refresh so the session list picks it up.
                self.onSpawned()
                if isCurrent { self.dismiss() }
            } else {
                let reason = errText.trimmingCharacters(in: .whitespacesAndNewlines)
                NSLog("GhostType: drive launch failed for pane %@: %@", pid, reason.isEmpty ? "(no output)" : reason)
                guard isCurrent else { return }
                self.caption?.textColor = .systemRed
                self.caption?.stringValue = reason.isEmpty ? "failed to start — try again" : String(reason.prefix(80))
                self.panel?.makeFirstResponder(self.field)
            }
        }
    }
}
