import AppKit
import SwiftUI

// One Terminal.app tab, as the picker sees it. Tabs already inside tmux are filtered out
// upstream (they're either in the sessions list already or one `ghost join` from it), and
// busy tabs can't be wrapped from outside — a running claude owns the tty — so they render
// disabled with the recipe instead of a dead click.
struct TermTab: Identifiable {
    let windowId: Int
    let tabIndex: Int
    let tty: String
    let busy: Bool
    let process: String
    let windowName: String
    var id: String { "\(windowId).\(tabIndex)" }
}

// The picker's whole lifecycle: list Terminal.app tabs, click an idle one, the app types
// `ghost join` into it via Apple Events (Terminal's `do script` runs in THAT tab's shell).
// Same KeyPanel species as the goal panel — flush under the status item, Esc or click-away
// to dismiss.
final class TerminalPickerController: NSObject {
    private var panel: KeyPanel?
    private var escMonitor: Any?
    private var previousApp: NSRunningApplication?
    private let model: GhostModel
    private let onJoined: () -> Void

    init(model: GhostModel, onJoined: @escaping () -> Void) {
        self.model = model
        self.onJoined = onJoined
    }

    func show(near button: NSStatusBarButton) {
        dismiss()
        model.listTerminalTabs { [weak self] tabs in
            guard let self else { return }
            self.present(tabs: tabs, near: button)
        }
    }

    private func present(tabs: [TermTab], near button: NSStatusBarButton) {
        let width: CGFloat = 390
        let content = TerminalPickerView(
            tabs: tabs,
            onPick: { [weak self] tab in self?.join(tab) },
            onClose: { [weak self] in self?.dismiss() }
        )
        let host = NSHostingView(rootView: content)
        host.frame.size = host.fittingSize
        let height = max(host.frame.height, 56)

        let panel = KeyPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        panel.contentView = host

        if let buttonWindow = button.window {
            let onScreen = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
            panel.setFrameOrigin(NSPoint(x: onScreen.minX, y: onScreen.minY - height))
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(panelResignedKey(_:)),
            name: NSWindow.didResignKeyNotification, object: panel
        )
        // No text field here, so Escape has no field editor to climb from — a local monitor
        // is the smallest thing that gives the panel the same esc-closes contract.
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] ev in
            if ev.keyCode == 53 { self?.dismiss(); return nil }
            return ev
        }
        self.panel = panel
        previousApp = NSWorkspace.shared.frontmostApplication
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    private func join(_ tab: TermTab) {
        // Both roads lead through `ghost adopt`: idle → scripted join; running agent →
        // Ctrl-C ×2 → join → same command + --continue. One click either way.
        model.adoptTab(tty: tab.tty) { [weak self] ok in
            guard let self else { return }
            if ok { self.onJoined() }
            self.dismiss()
        }
    }

    func dismiss() {
        if let escMonitor { NSEvent.removeMonitor(escMonitor); self.escMonitor = nil }
        guard let panel else { return }
        NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: panel)
        panel.orderOut(nil)
        self.panel = nil
        if let previousApp {
            if #available(macOS 14.0, *) { previousApp.activate() } else { previousApp.activate(options: []) }
        }
        previousApp = nil
    }

    @objc private func panelResignedKey(_ note: Notification) {
        // Click-away: the user moved on — don't yank focus back (same contract as GoalPanel).
        if let escMonitor { NSEvent.removeMonitor(escMonitor); self.escMonitor = nil }
        guard let panel else { return }
        NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: panel)
        panel.orderOut(nil)
        self.panel = nil
        previousApp = nil
    }
}

// The picker face: real Terminal tabs, idle ones clickable, busy ones honest about why not.
struct TerminalPickerView: View {
    let tabs: [TermTab]
    let onPick: (TermTab) -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s2) {
            Text("ADD A TERMINAL").font(Theme.label).tracking(Theme.labelTracking).foregroundColor(Theme.ink3)
            if tabs.isEmpty {
                Text("no Terminal tabs found")
                    .font(Theme.body).foregroundColor(Theme.ink3)
            } else {
                VStack(spacing: 3) {
                    ForEach(tabs) { tab in
                        TermTabRow(tab: tab) { onPick(tab) }
                    }
                }
                if tabs.contains(where: { $0.busy }) {
                    Text("connect restarts the agent with --continue — history kept, ~3s blip")
                        .font(Theme.caption).foregroundColor(Theme.ink3)
                }
            }
            CopyJoinRow()
        }
        .padding(.horizontal, Theme.margin)
        .padding(.vertical, Theme.Space.s3)
        .frame(width: 390)
        .background(VisualEffect(material: .menu).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous)))
    }
}

// The do-it-yourself road, one click away: copies `ghost join` so any terminal —
// iTerm, ssh, whatever the picker can't see — can turn itself on with a paste.
struct CopyJoinRow: View {
    @State private var hover = false
    @State private var copied = false
    var body: some View {
        Button(action: {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString("ghost join", forType: .string)
            withAnimation(.easeOut(duration: 0.12)) { copied = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                withAnimation(.easeOut(duration: 0.3)) { copied = false }
            }
        }) {
            HStack(spacing: 10) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(copied ? Theme.violet : (hover ? Theme.ink2 : Theme.ink3))
                    .frame(width: 12)
                Text("ghost join").font(Theme.value)
                    .foregroundColor(hover || copied ? Theme.ink : Theme.ink2)
                Text(copied ? "copied — paste in any terminal" : "copy · turns on the terminal you paste it in")
                    .font(Theme.caption).foregroundColor(copied ? Theme.violet : Theme.ink3)
                Spacer()
            }
            .padding(.horizontal, Theme.Space.s3)
            .padding(.vertical, 6)
            .background(hover ? Theme.hover : Color.clear)
            .cornerRadius(Theme.rowRadius)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
    }
}

struct TermTabRow: View {
    let tab: TermTab
    let action: () -> Void
    @State private var hover = false

    // A busy CODING AGENT can be adopted (Ctrl-C → join → --continue restores it); any
    // other busy process would lose real state to a Ctrl-C, so those stay hands-off.
    private var connectable: Bool {
        !tab.busy || ["claude", "codex", "aider"].contains(tab.process.lowercased())
    }

    // Terminal window names are "angus — ✳ project-title — caffeinate ◂ claude --flags —
    // 120×38": the ONLY segment a human recognizes is the tab title in the middle. Keep
    // that; drop the username, the command chain, the size suffix, and the status spinner
    // glyph Claude Code prefixes it with.
    private var cleanName: String {
        let segments = tab.windowName.components(separatedBy: " — ")
        let user = NSUserName()
        let candidate = segments.first { seg in
            let t = seg.trimmingCharacters(in: .whitespaces)
            if t.isEmpty || t == user { return false }
            if t.range(of: #"^\d+×\d+$"#, options: .regularExpression) != nil { return false }
            if t.contains("◂") || t.contains("--") { return false }
            if t.lowercased() == tab.process.lowercased() { return false }
            if t.hasSuffix("zsh") || t.hasSuffix("bash") { return false }
            return true
        }
        guard var best = candidate?.trimmingCharacters(in: .whitespaces) else {
            return "\(tab.process) · \(shortTty)"
        }
        if let r = best.rangeOfCharacter(from: .alphanumerics) { best = String(best[r.lowerBound...]) }
        return best
    }
    private var shortTty: String { tab.tty.replacingOccurrences(of: "/dev/", with: "") }

    var body: some View {
        Button(action: { if connectable { action() } }) {
            HStack(spacing: 10) {
                Circle()
                    .fill(Color.clear)
                    .overlay(Circle().stroke(Theme.ink3, lineWidth: 1))
                    .frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text(cleanName).font(Theme.value).foregroundColor(connectable ? Theme.ink : Theme.ink3)
                        .lineLimit(2).truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(tab.process) · \(shortTty)")
                        .font(Theme.caption).foregroundColor(Theme.ink3)
                        .lineLimit(1)
                }
                Spacer()
                Text(connectable ? (tab.busy ? "connect" : "join") : "ctrl-c first")
                    .font(Theme.caption)
                    .foregroundColor(connectable ? (hover ? Theme.ink2 : Theme.ink3) : Theme.ink3)
            }
            .padding(.horizontal, Theme.Space.s3)
            .padding(.vertical, Theme.Space.s2)
            .background(hover && connectable ? Theme.hover : Color.clear)
            .cornerRadius(Theme.rowRadius)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
    }
}
