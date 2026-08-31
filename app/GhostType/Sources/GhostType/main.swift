import AppKit
import SwiftUI

// ---------- Theme (Headroom philosophy: sit in the material; accent only where it's live) ----------
enum Theme {
    static let ink  = Color.primary
    static let ink2 = Color.primary.opacity(0.72)
    static let ink3 = Color.primary.opacity(0.48)
    static let hairline = Color(nsColor: .separatorColor)
    static let hover = Color(nsColor: .unemphasizedSelectedContentBackgroundColor)
    // The one accent — spent only on a session that is actually being driven.
    static let violet = Color(red: 0.545, green: 0.361, blue: 0.965)
    static let violetSoft = Color(red: 0.718, green: 0.580, blue: 0.965)

    static let hero = Font.system(size: 34, weight: .regular).monospacedDigit()
    static let value = Font.system(size: 12.5, weight: .medium, design: .monospaced)
    static let body = Font.system(size: 12.5, weight: .medium)
    static let caption = Font.system(size: 11, weight: .medium)
    static let label = Font.system(size: 11, weight: .bold)
    static let labelTracking: CGFloat = 0.55

    enum Space {
        static let s1: CGFloat = 4
        static let s2: CGFloat = 8
        static let s3: CGFloat = 12
        static let s4: CGFloat = 16
        static let s5: CGFloat = 20
    }
    static let rowRadius: CGFloat = 7
    static let margin: CGFloat = 16
    // `.accessoryBar` buttons carry their own leading inset (Headroom Theme.Measure, same
    // value) — cancelled with negative padding on the footer so the first glyph sits on the
    // margin instead of parked inboard of every row above it (round-36 audit #22).
    static let accessoryInset: CGFloat = 11
}

// Native vibrancy. The dropdown gets its frosted look from NSMenu itself, so GhostPanel no
// longer wraps its content in this — but the goal panel is a bare NSPanel with no vibrancy
// of its own, so GoalPanel.swift reuses this for its background, material: .menu.
struct VisualEffect: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .menu
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material; v.blendingMode = .behindWindow; v.state = .active
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}

// ---------- The dropdown content ----------
// No painted background here — the NSMenu this is hosted in supplies its own vibrancy,
// unlike the old NSPopover version.
struct GhostPanel: View {
    @ObservedObject var model: GhostModel
    let onSelect: (Session) -> Void
    let onAddTerminal: () -> Void
    let onRefresh: () -> Void
    let onReport: () -> Void
    let onQuit: () -> Void
    @State private var breathe = false

    private func scaleLabel(_ t: String) -> some View {
        Text(t).font(Theme.label).tracking(Theme.labelTracking).foregroundColor(Theme.ink3)
    }
    private var rule: some View { Divider().padding(.horizontal, -Theme.margin) }

    // ps-verified AND still a real tmux pane — a pane that just closed can stay ps-alive in
    // model.liveDriving for a few more seconds until its own drive loop notices pane-gone
    // and exits, so counting liveDriving alone here could show "1" while the session list
    // below (scoped to model.sessions) shows nothing driving. Same intersection
    // paintMenuBar already uses for the menu-bar title, applied to the hero numeral too.
    private var drivingCount: Int {
        model.sessions.filter { model.liveDriving[$0.paneId] != nil }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s2) {
            // instrument header — the count of sessions actually being driven is the reading.
            // No app-name label above the numeral (Headroom's own convention, which this
            // popover otherwise follows throughout, never names itself in the dropdown either
            // — a scale label's contract here is "names the number under it," and "driving"
            // is already said explicitly in the caption beside the numeral).
            HStack(alignment: .center) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text("\(drivingCount)").font(Theme.hero)
                        .foregroundColor(drivingCount == 0 ? Theme.ink3 : Theme.violet)
                    Text(drivingCount == 1 ? "session driving" : "sessions driving")
                        .font(Theme.caption).foregroundColor(Theme.ink3)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 5) {
                    Circle().fill(model.daemonStatus == "off" ? Theme.ink3 : Theme.violet).frame(width: 8, height: 8)
                        // Gated the same way the shadow color below already is — an idle
                        // dot has no business perpetually pulsing (round-36 audit #21).
                        .opacity(model.daemonStatus == "off" ? 0.45 : (breathe ? 1 : 0.45))
                        .shadow(color: (model.daemonStatus == "off" ? Color.clear : Theme.violet).opacity(0.7), radius: breathe ? 6 : 2)
                        .animation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true), value: breathe)
                    Text(model.daemonStatus == "off" ? "idle" : model.daemonStatus)
                        .font(Theme.caption).foregroundColor(model.daemonStatus == "off" ? Theme.ink3 : Theme.violetSoft)
                }
            }

            rule
            scaleLabel("SESSIONS").padding(.top, 2)

            if model.sessions.isEmpty {
                Text("no terminals here yet — add one below, or type `ghost join` in any terminal")
                    .font(Theme.caption).foregroundColor(Theme.ink3)
                    .padding(.vertical, Theme.Space.s2)
            } else {
                VStack(spacing: 3) {
                    ForEach(model.sessions) { s in
                        SessionRow(session: s, driving: model.liveDriving[s.paneId] != nil) { onSelect(s) }
                    }
                }
            }
            AddTerminalRow { onAddTerminal() }

            rule
            footer
        }
        .padding(.horizontal, Theme.margin)
        .padding(.top, Theme.Space.s4)
        .padding(.bottom, Theme.Space.s3)
        .frame(width: 300)
        .onAppear { breathe = true }
    }

    // Native controls, glyph + word — Headroom's footer idiom, not hand-rolled text buttons.
    private var footer: some View {
        HStack(spacing: Theme.Space.s1) {
            control("Refresh", "arrow.clockwise") { onRefresh() }
            control("Report", "doc.text") { onReport() }
            Spacer(minLength: Theme.Space.s2)
            control("Quit", "power") { onQuit() }
        }
        .controlSize(.small)
        .modifier(AccessoryBarStyle())
        .imageScale(.small)
        .padding(.horizontal, -Theme.accessoryInset)
    }

    private func control(_ title: String, _ symbol: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).font(Theme.caption)
        }
        .help(title)
    }
}

// The macOS 13 fallback below has no native hover affordance, unlike `.accessoryBar` or
// SessionRow's own hand-rolled `@State hover` — same idiom as SessionRow (and Headroom's
// AccountRow), reused here so the footer isn't the one clickable row in the panel with no
// hover feedback, just on the older-OS path.
private struct HoverAccessoryStyle: ButtonStyle {
    @State private var hover = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(hover ? Theme.ink : Theme.ink2)
            .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
    }
}

// `.accessoryBar` needs macOS 14; the app targets macOS 13 (Package.swift), so this falls
// back to a hand-rolled hover style there rather than raising the deployment target for one
// button style. Per-button, not a modifier on the whole footer HStack — a single `.onHover`
// wrapping every button together would light all of them up at once instead of just the one
// under the cursor.
private struct AccessoryBarStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 14.0, *) {
            content.buttonStyle(.accessoryBar)
        } else {
            content.buttonStyle(HoverAccessoryStyle())
        }
    }
}

// The picker's front door: a quiet row, same species as the sessions above it, that opens
// the Terminal-tab picker — click the terminal you mean and it joins itself.
struct AddTerminalRow: View {
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "plus")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(hover ? Theme.ink2 : Theme.ink3)
                    .frame(width: 8)
                Text("add a terminal")
                    .font(Theme.caption).foregroundColor(hover ? Theme.ink2 : Theme.ink3)
                Spacer()
            }
            .padding(.horizontal, Theme.Space.s3)
            .padding(.vertical, 5)
            .background(hover ? Theme.hover : Color.clear)
            .cornerRadius(Theme.rowRadius)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
    }
}

struct SessionRow: View {
    let session: Session
    let driving: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Circle()
                    .fill(driving ? Theme.violet : Color.clear)
                    .overlay(driving ? nil : Circle().stroke(Theme.ink3, lineWidth: 1))
                    .frame(width: 8, height: 8)
                    .shadow(color: driving ? Theme.violet.opacity(0.8) : .clear, radius: 4)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.target).font(Theme.value).foregroundColor(Theme.ink)
                    Text(session.cmd).font(Theme.caption).foregroundColor(Theme.ink3)
                }
                Spacer()
                Text(driving ? "driving" : "drive")
                    .font(Theme.caption)
                    .foregroundColor(driving ? (hover ? Theme.violet : Theme.violetSoft) : (hover ? Theme.ink2 : Theme.ink3))
            }
            .padding(.horizontal, Theme.Space.s3)
            .padding(.vertical, Theme.Space.s2)
            // A driving row is the one click here with a real, immediate effect (undrive,
            // no confirmation) — it deserves its own hover signal, not the same fixed tint
            // whether or not the pointer is over it (round-36 audit #20).
            .background(driving ? Theme.violet.opacity(hover ? 0.20 : 0.12) : (hover ? Theme.hover : Color.clear))
            .cornerRadius(Theme.rowRadius)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
    }
}

// ---------- Menu-bar host ----------
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    // The dropdown is an NSMenu carrying one full-width custom view, not an NSPopover — a
    // menu drops welded to the status item with no gap and no arrow; a popover always
    // floats slightly below it. Reference: Headroom AppDelegate.showDropdown().
    private var menu: NSMenu?
    // Kept only so a refresh that resolves while this exact menu is still tracking can
    // re-fit its frame to freshly-arrived content (see showDropdown).
    private var dropdownHost: NSHostingView<GhostPanel>?
    private var goalPanel: GoalPanelController!
    private var terminalPicker: TerminalPickerController!
    private let model = GhostModel()
    private var timer: Timer?
    // The ONLY app-side state: which drives this app itself spawned, so quit can stop
    // those and only those. A CLI-started drive outlives the menu bar app closing.
    //
    // Keyed by paneId -> the SET of pids drive was spawned with, not just the paneId
    // alone — a paneId-only Set can't tell "the drive we spawned" apart from an unrelated
    // one a CLI invocation later starts on the same pane, so a pane-id match alone isn't
    // enough to prove Quit's target is still ours (claim #13). The pid is what
    // `ghost undrive --pid` checks before it will SIGINT anything.
    //
    // A Set, not a single Int32: dismiss() during an in-flight submission now best-effort
    // cancels the drive (GoalPanel.swift), but that cancel is fire-and-forget and can lose
    // the race against the child's own claimDrive — a user who then reselects the SAME pane
    // and resubmits produces a second app-spawned pid before the first is confirmed dead.
    // onLaunched fires for both, deliberately not gated on `generation`; a plain assignment
    // there is last-write-wins and can silently drop tracking of whichever pid is actually
    // still alive (typically the FIRST, since claimDrive is FIFO and the second exits within
    // milliseconds via the already-driving guard) — orphaning it past Quit (round-42 audit
    // #1). Each pid is independently pid-verified before Quit acts on it, so tracking more
    // than one per pane costs nothing: `ghost undrive --pid` refuses unless it's still the
    // exact live drive there.
    private var appSpawnedPaneIds: [String: Set<Int32>] = [:]
    // When each app-spawned pid launched — a just-born child isn't registry-visible yet,
    // and the periodic prune must not disown it before it can claim (round-44 swift#4).
    private var pidLaunchDates: [Int32: Date] = [:]
    private let violetNS = NSColor(red: 0.545, green: 0.361, blue: 0.965, alpha: 1)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        installEditMenu()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusItemClicked(_:))
        // Fire on mouse-UP (Headroom's exact line): with the default mouse-down action,
        // showDropdown's performClick opens the menu while the physical button is still
        // held, and the release instantly dismisses it — a click that looks like nothing.
        statusItem.button?.sendAction(on: [.leftMouseUp])

        goalPanel = GoalPanelController(model: model, onLaunched: { [weak self] paneId, pid in
            // The instant the child process exists, not gated on confirming the drive
            // actually took — see GoalPanel.swift's submit() and Model.swift's startDrive
            // doc for why (round-39 audit #1). Inserted into the per-pane set, never assigned
            // outright — see appSpawnedPaneIds' own doc comment for why overwriting is unsafe
            // (round-42 audit #1).
            // Synchronous hop: Quit reads this state on main the instant it fires — an
            // async insert could lose the race and orphan a drive (round-44 swift#4).
            DispatchQueue.main.sync {
                self?.appSpawnedPaneIds[paneId, default: []].insert(pid)
                self?.pidLaunchDates[pid] = Date()
            }
        }, onSpawned: { [weak self] in
            self?.model.refresh()
        })

        terminalPicker = TerminalPickerController(model: model) { [weak self] in self?.model.refresh() }

        updateMenuBar()
        // .common so the label keeps updating while the dropdown or goal panel is
        // tracking — a timer scheduled the ordinary way silently pauses during tracking.
        let t = Timer(timeInterval: 4, repeats: true) { [weak self] _ in self?.updateMenuBar() }
        RunLoop.main.add(t, forMode: .common)
        timer = t

        // Launch feedback: an accessory app has no window and no Dock bounce, so a launch
        // with no open dropdown is indistinguishable from "nothing happened" — but an
        // opening NSMenu GRABS THE KEYBOARD, so it must never appear spontaneously (a
        // login-item or scripted launch popping a menu mid-keystroke steals the user's
        // typing — reported live as "a glitch while I'm typing"). NSApp.isActive separates
        // the two: a user double-click activates the app, a background launch doesn't.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            // keyWindow nil too: the user may have raced ahead into the goal panel, whose
            // own activation would otherwise satisfy isActive and let this menu grab the
            // keyboard mid-goal-typing (round-44 swift#5).
            if NSApp.isActive && NSApp.keyWindow == nil { self?.showDropdown() }
        }
    }

    // Double-clicking the app icon while it's already running fires reopen, not launch —
    // without this it looks like the app "won't open". Same feedback: show the dropdown.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showDropdown()
        return true
    }

    // Only drives this app spawned are stopped here — a CLI-started drive is left running,
    // same as it would be if the terminal that started it were still open. The pid guard
    // (undriveBlocking -> `ghost undrive --pid`) is what actually enforces that: even if
    // this set is stale (an app-spawned drive already exited, or a different drive now
    // occupies the same pane id), the kill is refused unless the live drive's pid still
    // matches exactly (claim #13).
    func applicationWillTerminate(_ notification: Notification) {
        for (paneId, pids) in appSpawnedPaneIds {
            for pid in pids {
                model.undriveBlocking(paneId, expectedPid: pid)
            }
        }
    }

    /// An accessory app installs no application menu of its own, so without this Command-V
    /// is a silent no-op in the goal field — paste defense-in-depth alongside the field's
    /// own performKeyEquivalent override.
    private func installEditMenu() {
        let main = NSMenu()
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(editItem)
        main.setSubmenu(edit, for: editItem)
        NSApp.mainMenu = main
    }

    // The ghost itself in the menu bar — the exact brand glyph, shipped as a rendered
    // template PNG in Resources (a hand-ported bezier approximation read as a blob). As a
    // TEMPLATE image macOS paints it white on dark bars, black on light; driving tints the
    // same alpha mask violet via sourceAtop.
    private static let ghostBase: NSImage = {
        let path = Bundle.main.path(forResource: "ghost-menu@2x", ofType: "png") ?? ""
        let img = NSImage(contentsOfFile: path) ?? NSImage(size: NSSize(width: 18, height: 18))
        img.size = NSSize(width: 18, height: 18)
        return img
    }()
    private func ghostGlyph(_ color: NSColor, template: Bool) -> NSImage {
        let base = Self.ghostBase
        if template {
            let i = base.copy() as! NSImage
            i.isTemplate = true
            return i
        }
        let i = NSImage(size: base.size, flipped: false) { rect in
            base.draw(in: rect)
            color.setFill()
            rect.fill(using: .sourceAtop)
            return true
        }
        return i
    }

    // Menu-bar title = the terminal name it's driving (or a quiet dot when idle). Paints
    // twice per tick: once immediately from whatever data we already have (so the button
    // is never left blank), then again once THIS tick's refresh actually resolves —
    // otherwise the title always trails the async refresh by a full 4s cycle, worst on
    // cold launch where the first paint had nothing but the [] / [:] defaults (round-36
    // audit #1/#11).
    private func updateMenuBar() {
        paintMenuBar()
        model.refresh { [weak self] in
            guard let self else { return }
            // Pid-verified, not just pane-id: a pane whose app-spawned drive exited (or
            // whose pane id was taken over by a newer drive, app- or CLI-started) drops out
            // here the instant the registry no longer names THIS pid as the live drive
            // there — closing the gap a pane-id-only prune left open, where a later CLI
            // drive reusing the same pane id could still be SIGINT'd by us at quit
            // (round-36 audit #8/#16; broadened per claim #13). Per-pid, not per-pane, now
            // that a pane can carry more than one app-spawned pid at once (round-42 audit
            // #1) — only the pids that are no longer the live drive there are dropped; the
            // pane's key itself is dropped only once none of its tracked pids are live.
            var pruned: [String: Set<Int32>] = [:]
            for (paneId, pids) in self.appSpawnedPaneIds {
                let live = pids.filter { pid in
                    if self.model.liveDriving[paneId]?.pid == Int(pid) { return true }
                    // 10s grace for a just-launched child that hasn't claimed yet
                    if let born = self.pidLaunchDates[pid], Date().timeIntervalSince(born) < 10 { return true }
                    return false
                }
                if !live.isEmpty { pruned[paneId] = live }
            }
            self.appSpawnedPaneIds = pruned
            self.pidLaunchDates = self.pidLaunchDates.filter { Date().timeIntervalSince($0.value) < 60 }
            self.paintMenuBar()
        }
    }

    private func paintMenuBar() {
        guard let button = statusItem.button else { return }
        // Most-recently-started drive first, not tmux's pane-enumeration order — otherwise
        // the title sticks to whichever driven pane happens to sort first regardless of
        // which drive is actually newest (round-36 audit #23).
        let driven = model.sessions
            .filter { model.liveDriving[$0.paneId] != nil }
            .sorted { (model.liveDriving[$0.paneId]?.startedAt ?? "") > (model.liveDriving[$1.paneId]?.startedAt ?? "") }
        if let first = driven.first {
            let extra = driven.count > 1 ? " +\(driven.count - 1)" : ""
            button.image = ghostGlyph(violetNS, template: false)
            button.imagePosition = .imageLeading
            button.title = " \(first.name)\(extra)"
        } else {
            button.image = ghostGlyph(.black, template: true)
            button.imagePosition = .imageOnly
            button.title = ""
        }
    }

    @objc private func statusItemClicked(_ sender: Any?) {
        showDropdown()
    }

    /// Headroom's exact idiom: a fresh NSMenu per click, one NSMenuItem whose view is an
    /// NSHostingView sized via fittingSize. `statusItem.menu` is set only for the duration
    /// of the click and cleared straight after — leaving it assigned would swallow the
    /// button's action on the next click.
    private func showDropdown() {
        let menu = NSMenu()
        menu.delegate = self

        let host = NSHostingView(rootView: GhostPanel(
            model: model,
            onSelect: { [weak self] session in self?.selected(session) },
            onAddTerminal: { [weak self] in
                guard let self else { return }
                self.dismissDropdown()
                if let button = self.statusItem.button { self.terminalPicker.show(near: button) }
            },
            onRefresh: { [weak self] in self?.refreshDropdown() },
            onReport: { [weak self] in
                self?.dismissDropdown()
                NSWorkspace.shared.open(URL(fileURLWithPath: "\(NSHomeDirectory())/dev/pages/ghost-type/latest.html"))
            },
            onQuit: { NSApp.terminate(nil) }
        ))
        // A menu item will not size a SwiftUI view for you — without an explicit frame the
        // row collapses to zero height and the menu looks empty.
        host.frame.size = host.fittingSize

        let item = NSMenuItem()
        item.view = host
        menu.addItem(item)

        self.menu = menu
        dropdownHost = host
        // Re-refresh for this click (the periodic timer's last tick can be up to 4s stale)
        // and re-fit THIS SAME item's frame once it resolves — GhostPanel's body already
        // redraws from the fresh @Published data on its own, but nothing else grows the
        // NSHostingView's declared frame to match, so new rows would render clipped until
        // the menu is closed and reopened (round-36 audit #6). The identity check guards
        // against acting after this exact dropdown has already been dismissed.
        model.refresh { [weak self, weak menu] in
            guard let self, let menu, self.menu === menu, let host = self.dropdownHost else { return }
            host.frame.size = host.fittingSize
        }
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    private func dismissDropdown() {
        menu?.cancelTracking()
        menu = nil
        dropdownHost = nil
    }

    // The footer's manual "Refresh" button — same re-fit obligation as showDropdown's own
    // opening refresh (round-36 audit #6), just triggered by a click instead of the menu
    // opening. Without this, model.sessions/liveDriving update and GhostPanel's body redraws
    // with the new content, but the enclosing NSHostingView's frame — fixed once at menu-open
    // time — never grows to match, so a newly-arrived row renders clipped until the menu is
    // closed and reopened (round-37 audit #2). Same identity-check pattern as showDropdown:
    // a captured, weakly-held snapshot of `menu` at click time guards against acting after
    // this exact dropdown has already been dismissed (or a new one opened) by the time the
    // refresh resolves.
    private func refreshDropdown() {
        let trackedMenu = menu
        model.refresh { [weak self, weak trackedMenu] in
            guard let self, let trackedMenu, self.menu === trackedMenu, let host = self.dropdownHost else { return }
            host.frame.size = host.fittingSize
        }
    }

    // Idle row → goal panel; driving row → immediate undrive, no panel. Truthful either
    // way, since "driving" only ever reflects liveDriving from the ps-verified registry.
    private func selected(_ session: Session) {
        dismissDropdown()
        if model.liveDriving[session.paneId] != nil {
            model.undrive(session.paneId)
            // Not removed from appSpawnedPaneIds here — undrive() is fire-and-forget, and
            // clearing local bookkeeping before the stop is confirmed would let Quit lose
            // its only remaining lever on a drive that's actually still running if the
            // undrive silently failed. updateMenuBar's periodic, pid-verified prune is the
            // sole authority for dropping an entry, once the registry confirms this exact
            // pid is no longer the live drive on this pane (round-36 audit #8/#16
            // follow-up; harmless no-op either way if this pane was CLI-started).
        } else if let button = statusItem.button {
            goalPanel.show(for: session, near: button)
        }
    }

    // MARK: NSMenuDelegate
    func menuDidClose(_ menu: NSMenu) {
        self.menu = nil
        dropdownHost = nil
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
