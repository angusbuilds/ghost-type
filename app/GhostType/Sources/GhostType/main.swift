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
}

// Native vibrancy — the popover's frosted material shows through instead of an opaque paint.
struct VisualEffect: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .popover; v.blendingMode = .behindWindow; v.state = .active
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}

// ---------- Bridge to the ghost CLI ----------
struct Session: Identifiable, Decodable {
    let paneId: String, session: String, cmd: String, target: String
    var windowName: String = ""
    var title: String = ""
    var id: String { paneId }

    // Short label for the menu bar: a real window name, else the command, else the target.
    var name: String {
        let w = windowName.trimmingCharacters(in: .whitespaces)
        if !w.isEmpty, w != cmd, !(w.first?.isNumber ?? false) { return w }
        if cmd != "zsh", cmd != "bash", !cmd.isEmpty { return cmd }
        return target
    }
}

final class GhostModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var haunted: Set<String> = []
    @Published var daemonStatus: String = "off"

    private let node = "/opt/homebrew/bin/node"
    private let ghost = "\(NSHomeDirectory())/dev/ghost-type/bin/ghost.mjs"
    private var hauntedFile: String { "\(NSHomeDirectory())/.ghosttype/haunted.json" }
    private var stateFile: String { "\(NSHomeDirectory())/.ghosttype/state.json" }

    @discardableResult private func run(_ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [ghost] + args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        p.environment = env
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
        do { try p.run(); p.waitUntilExit() } catch { return "" }
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    func refresh() {
        let out = run(["sessions", "--json"])
        sessions = (out.data(using: .utf8).flatMap { try? JSONDecoder().decode([Session].self, from: $0) }) ?? []
        if let d = try? Data(contentsOf: URL(fileURLWithPath: hauntedFile)),
           let arr = try? JSONDecoder().decode([String].self, from: d) { haunted = Set(arr) } else { haunted = [] }
        if let d = try? Data(contentsOf: URL(fileURLWithPath: stateFile)),
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let s = obj["status"] as? String { daemonStatus = s } else { daemonStatus = "off" }
    }

    func toggle(_ s: Session) {
        run([haunted.contains(s.paneId) ? "unhaunt" : "haunt", s.paneId]); refresh()
    }
}

// ---------- The panel ----------
struct GhostPanel: View {
    @ObservedObject var model: GhostModel
    @State private var breathe = false

    private func scaleLabel(_ t: String) -> some View {
        Text(t).font(Theme.label).tracking(Theme.labelTracking).foregroundColor(Theme.ink3)
    }
    private var rule: some View { Divider().padding(.horizontal, -Theme.margin) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s2) {
            // instrument header — the count of sessions being driven is the one reading
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    scaleLabel("GHOST TYPE")
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("\(model.haunted.count)").font(Theme.hero)
                            .foregroundColor(model.haunted.isEmpty ? Theme.ink3 : Theme.violet)
                        Text(model.haunted.count == 1 ? "session driving" : "sessions driving")
                            .font(Theme.caption).foregroundColor(Theme.ink3)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 5) {
                    Circle().fill(model.daemonStatus == "off" ? Theme.ink3 : Theme.violet).frame(width: 8, height: 8)
                        .opacity(breathe ? 1 : 0.45)
                        .shadow(color: (model.daemonStatus == "off" ? Color.clear : Theme.violet).opacity(0.7), radius: breathe ? 6 : 2)
                        .animation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true), value: breathe)
                    Text(model.daemonStatus == "off" ? "idle" : model.daemonStatus)
                        .font(Theme.caption).foregroundColor(model.daemonStatus == "off" ? Theme.ink3 : Theme.violetSoft)
                }.padding(.top, 2)
            }

            rule
            scaleLabel("SESSIONS").padding(.top, 2)

            if model.sessions.isEmpty {
                Text("no tmux sessions running")
                    .font(Theme.body).foregroundColor(Theme.ink3)
                    .padding(.vertical, Theme.Space.s2)
            } else {
                VStack(spacing: 3) {
                    ForEach(model.sessions) { s in
                        SessionRow(session: s, on: model.haunted.contains(s.paneId)) { model.toggle(s) }
                    }
                }
            }

            rule
            HStack(spacing: Theme.Space.s4) {
                FooterButton("Refresh") { model.refresh() }
                FooterButton("Report") {
                    NSWorkspace.shared.open(URL(fileURLWithPath: "\(NSHomeDirectory())/dev/pages/ghost-type/latest.html"))
                }
                Spacer()
                FooterButton("Quit") { NSApp.terminate(nil) }
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, Theme.margin)
        .padding(.top, Theme.Space.s4)
        .padding(.bottom, Theme.Space.s3)
        .frame(width: 300)
        .background(VisualEffect().ignoresSafeArea())
        .onAppear { model.refresh(); breathe = true }
    }
}

struct SessionRow: View {
    let session: Session
    let on: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Circle()
                    .fill(on ? Theme.violet : Color.clear)
                    .overlay(on ? nil : Circle().stroke(Theme.ink3, lineWidth: 1))
                    .frame(width: 8, height: 8)
                    .shadow(color: on ? Theme.violet.opacity(0.8) : .clear, radius: 4)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.target).font(Theme.value).foregroundColor(Theme.ink)
                    Text(session.cmd).font(Theme.caption).foregroundColor(Theme.ink3)
                }
                Spacer()
                Text(on ? "driving" : "haunt")
                    .font(Theme.caption)
                    .foregroundColor(on ? Theme.violet : (hover ? Theme.ink2 : Theme.ink3))
            }
            .padding(.horizontal, Theme.Space.s3)
            .padding(.vertical, Theme.Space.s2)
            .background(on ? Theme.violet.opacity(0.12) : (hover ? Theme.hover : Color.clear))
            .cornerRadius(Theme.rowRadius)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
    }
}

struct FooterButton: View {
    let label: String
    let action: () -> Void
    @State private var hover = false
    init(_ label: String, action: @escaping () -> Void) { self.label = label; self.action = action }
    var body: some View {
        Button(action: action) {
            Text(label).font(Theme.caption).foregroundColor(hover ? Theme.ink : Theme.ink2)
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
    }
}

// ---------- Menu-bar host ----------
final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let popover = NSPopover()
    let model = GhostModel()
    var timer: Timer?
    let violetNS = NSColor(red: 0.545, green: 0.361, blue: 0.965, alpha: 1)

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.action = #selector(togglePopover)
            button.target = self
            button.imageHugsTitle = true
        }
        popover.contentSize = NSSize(width: 300, height: 360)
        popover.behavior = .transient
        popover.animates = true
        popover.contentViewController = NSHostingController(rootView: GhostPanel(model: model))
        updateMenuBar()
        // Keep the menu-bar label in step with what's actually being driven.
        timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.updateMenuBar() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.togglePopover() }
    }

    // A small solid dot — purple when driving, dim when idle. Replaces the emoji.
    private func dot(_ color: NSColor, size: CGFloat = 8) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size))
        img.lockFocus()
        color.setFill()
        NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: size, height: size)).fill()
        img.unlockFocus()
        img.isTemplate = false
        return img
    }

    // Menu-bar title = the terminal name it's driving (or a quiet dot when idle).
    func updateMenuBar() {
        model.refresh()
        guard let button = statusItem.button else { return }
        let driven = model.sessions.filter { model.haunted.contains($0.paneId) }
        if let first = driven.first {
            let extra = driven.count > 1 ? " +\(driven.count - 1)" : ""
            button.image = dot(violetNS)
            button.imagePosition = .imageLeading
            button.title = " \(first.name)\(extra)"
        } else {
            button.image = dot(.tertiaryLabelColor)
            button.imagePosition = .imageOnly
            button.title = ""
        }
    }

    @objc func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown { popover.performClose(nil) }
        else {
            model.refresh()
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKeyAndOrderFront(nil)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
