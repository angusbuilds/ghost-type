import Foundation
import Combine

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

// One LIVE `ghost drive` process, as reported by `ghost drives --json`. The registry is
// ps-verified on the Node side, so this is truthful even for a drive started from the CLI
// or one that outlived an app relaunch — never the app's own wish about what's running.
struct DriveEntry: Decodable {
    let pid: Int
    let goal: String
    let engine: String
    let startedAt: String
}

final class GhostModel: ObservableObject {
    @Published var sessions: [Session] = []
    @Published var liveDriving: [String: DriveEntry] = [:]
    @Published var daemonStatus: String = "off"

    // Process.executableURL does NOT consult PATH — it requires the exact file at that
    // literal path, so a hardcoded "/opt/homebrew/bin/node" throws on any machine where node
    // lives elsewhere (Intel Homebrew's /usr/local/bin, or ARM with node via nvm/volta/asdf
    // and no /opt/homebrew symlink) even though the PATH built below already lists those
    // locations — that PATH can only ever help ghost.mjs's OWN subprocess lookups (git/tmux),
    // never resolve `node` itself, since executableURL resolution happens first. Routing
    // through /usr/bin/env (which DOES consult PATH) makes that already-built PATH actually
    // do something for node too. GHOST_NODE_BIN overrides to a literal path, matching the
    // GHOST_CLAUDE_BIN/GHOST_CODEX_BIN override pattern in src/lib.mjs (round-38 audit #3).
    private let node = ProcessInfo.processInfo.environment["GHOST_NODE_BIN"] ?? "/usr/bin/env"
    private var nodeIsEnvWrapper: Bool { node == "/usr/bin/env" }
    private let ghost = "\(NSHomeDirectory())/dev/ghost-type/bin/ghost.mjs"
    private var stateFile: String { "\(NSHomeDirectory())/.ghosttype/state.json" }

    // Serial: every shell-out to `ghost` — refresh reads, drive spawns, undrive — funnels
    // through one queue, so at most one node process is ever in flight and a refresh always
    // publishes sessions + drives together instead of racing two concurrent decodes onto
    // @Published properties.
    private let queue = DispatchQueue(label: "type.ghost.bridge")

    @discardableResult
    private func run(_ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = nodeIsEnvWrapper ? ["node", ghost] + args : [ghost] + args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        p.environment = env
        let pipe = Pipe(); p.standardOutput = pipe
        // Nothing reads stderr, so it goes straight to the null device rather than a Pipe —
        // a Pipe nobody drains fills its kernel buffer once `ghost` writes enough of it,
        // which blocks the child forever. And stdout is read to EOF BEFORE waitUntilExit:
        // readDataToEndOfFile blocks until the pipe's write end closes (the child exiting),
        // so it can never deadlock against a full stdout buffer the way reading only after
        // waitUntilExit could — that ordering was the other half of the same deadlock.
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return "" }
        let out = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: out, encoding: .utf8) ?? ""
    }

    // Off the main thread — two node spawns per tick would otherwise stall the UI, and a
    // menu open during a slow spawn would visibly stutter.
    //
    // completion runs on main, after THIS refresh's data has actually landed on the
    // @Published properties — callers that need to paint from the result (not just kick
    // off the next tick) must hang off completion, or they'll paint the PREVIOUS tick's
    // state instead (round-36 audit #1/#11).
    // Timer ticks with no completion coalesce: a slow bridge must not build a backlog of
    // identical polls ahead of user actions (codex round-44 swift#6).
    private let refreshGate = NSLock()
    private var queuedTimerRefreshes = 0
    func refresh(completion: (() -> Void)? = nil) {
        if completion == nil {
            refreshGate.lock()
            if queuedTimerRefreshes >= 2 { refreshGate.unlock(); return }
            queuedTimerRefreshes += 1
            refreshGate.unlock()
        }
        queue.async { [weak self] in
            defer {
                if completion == nil, let self {
                    self.refreshGate.lock(); self.queuedTimerRefreshes -= 1; self.refreshGate.unlock()
                }
            }
            guard let self else { return }
            let sessionsOut = self.run(["sessions", "--json"])
            let drivesOut = self.run(["drives", "--json"])
            // A failed shell-out or decode is UNKNOWN, not "nothing running" — keep the
            // last verified state instead of painting active rows idle (round-44 swift#7).
            let sessions = sessionsOut.data(using: .utf8)
                .flatMap { try? JSONDecoder().decode([Session].self, from: $0) }
            let driving = drivesOut.data(using: .utf8)
                .flatMap { try? JSONDecoder().decode([String: DriveEntry].self, from: $0) }
            var status = "off"
            if let d = try? Data(contentsOf: URL(fileURLWithPath: self.stateFile)),
               let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               let s = obj["status"] as? String { status = s }
            DispatchQueue.main.async {
                if let sessions { self.sessions = sessions }
                if let driving { self.liveDriving = driving }
                self.daemonStatus = status
                completion?()
            }
        }
    }

    // Detached: the app never retains or terminates this process, and never waits on it.
    // `ghost undrive` (SIGINT) is the only kill path, so the drive loop always exits
    // through its own cleanup — a Process.terminate() here would SIGTERM it instead and
    // strand the pane's tint and registry entry.
    //
    // completion(false, _) if the launch itself throws, OR if the process exits again within
    // a short grace window: ghost.mjs's already-driving guard and its arg parser both
    // reject fast, before a real drive ever reaches hauntDrive's poll loop, so an exit this
    // soon after a successful `run()` means the drive never actually started (round-36
    // audit #2/#10) — a bare `try?` here previously reported success on launch alone.
    //
    // The pid passed to completion is `p`'s own — `ghost drive` never forks or re-execs, so
    // this Process's pid IS the pid ghost.mjs's claimDrive registers under. The caller uses
    // it as a safety check, not to signal the process directly (claim #13): it's only valid
    // when ok is true, since a throw before `p.run()` succeeds never assigns a real pid.
    //
    // onLaunched fires the instant `p.run()` succeeds — well before `completion` settles.
    // applicationWillTerminate reads appSpawnedPaneIds synchronously, so Quit only ever
    // stops a drive that's already landed there; gating that registration on `completion`
    // (the 0.4s grace window below, or the process exiting) left a wide window where a real,
    // already-running child was invisible to Quit and got orphaned instead of SIGINT'd
    // (round-39 audit #1). A launch that turns out to be a fast failure still fires
    // onLaunched — harmless, since updateMenuBar's periodic pid-verified prune (main.swift)
    // already drops any entry that never becomes a live drive, and undriveBlocking is a
    // no-op against a pid the registry never actually names as live.
    func startDrive(paneId: String, goal: String, onLaunched: @escaping (Int32) -> Void, completion: @escaping (Bool, Int32, String) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: self.node)
            let driveArgs = [self.ghost, "drive", paneId, goal]
            p.arguments = self.nodeIsEnvWrapper ? ["node"] + driveArgs : driveArgs
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
            p.environment = env
            p.standardOutput = FileHandle.nullDevice
            // Captured, not discarded: a fast failure (bad args, an already-driving race, a
            // missing node binary) has its whole explanation on this stream, and dropping it
            // to /dev/null left that reason unrecoverable even by the app itself, so a failed
            // launch had nothing to show the user (round-39 audit #2). Drained continuously
            // via readabilityHandler rather than read once at exit — same deadlock this
            // file's `run()` already warns about (a full, undrained pipe blocks the child
            // forever), except here the drive can run for a long time before it ever exits,
            // so "read once at termination" isn't enough to guarantee the pipe never fills.
            // Bounded to the last 4KB so a chatty stream can't grow this without limit.
            let errPipe = Pipe()
            p.standardError = errPipe
            p.standardInput = FileHandle.nullDevice

            let errLock = NSLock()
            var errText = ""
            errPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                // Empty read = EOF. Must detach here — a closed pipe's read end stays
                // "readable" forever, so leaving the handler attached spins the run loop.
                guard !data.isEmpty else { handle.readabilityHandler = nil; return }
                errLock.lock()
                errText += String(data: data, encoding: .utf8) ?? ""
                if errText.utf8.count > 4096 { errText = String(errText.suffix(4096)) }
                errLock.unlock()
            }

            var settled = false
            let settle: (Bool) -> Void = { ok in
                guard !settled else { return }
                settled = true
                errLock.lock(); let captured = errText; errLock.unlock()
                DispatchQueue.main.async { completion(ok, p.processIdentifier, captured) }
            }
            // Foundation calls terminationHandler on an arbitrary queue — hop back onto
            // `queue` so the `settled` guard above is only ever touched serially.
            p.terminationHandler = { _ in self.queue.async { settle(false) } }
            do {
                try p.run()
            } catch {
                errPipe.fileHandleForReading.readabilityHandler = nil
                settle(false)
                return
            }
            DispatchQueue.main.async { onLaunched(p.processIdentifier) }
            self.queue.asyncAfter(deadline: .now() + 0.4) { settle(true) }
        }
    }

    // Terminal.app enrollment bridge. Listing and joining go through osascript because
    // Terminal is scriptable and tmux-wrapping a tab REQUIRES running `ghost join` inside
    // that tab's own shell — `do script` is the only supported way in. First use triggers
    // the one-time "GhostType wants to control Terminal" permission prompt.
    private func osascript(_ script: String) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    func listTerminalTabs(completion: @escaping ([TermTab]) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            struct RawTab: Decodable {
                let windowId: Int, tabIndex: Int, tty: String, busy: Bool
                let processes: [String], windowName: String
            }
            let out = self.run(["tabs", "--json"])
            let raw = out.data(using: .utf8).flatMap { try? JSONDecoder().decode([RawTab].self, from: $0) } ?? []
            let agents = ["claude", "codex", "aider", "grok"]
            let tabs = raw.map { r in
                TermTab(windowId: r.windowId, tabIndex: r.tabIndex, tty: r.tty, busy: r.busy,
                        process: r.processes.last(where: { agents.contains($0.lowercased()) }) ?? r.processes.last ?? "",
                        windowName: r.windowName)
            }
            DispatchQueue.main.async { completion(tabs) }
        }
    }

    // The picker's connect action. Detached, like startDrive: adoption now WAITS for the
    // agent to be idle before doing anything (up to 15 minutes — it never interrupts a
    // running task), and the bridge queue is serial — parking refresh behind a quarter-hour
    // wait would freeze every label in the app. The registry and the 4s refresh surface the
    // result when it lands; the CLI process logs its own progress.
    func adoptTab(tty: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = nodeIsEnvWrapper ? ["node", ghost, "adopt", tty] : [ghost, "adopt", tty]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    func undrive(_ paneId: String, expectedPid: Int32? = nil) {
        queue.async { [weak self] in
            var args = ["undrive", paneId]
            if let expectedPid { args += ["--pid", String(expectedPid)] }
            self?.run(args)
            DispatchQueue.main.async { self?.refresh() }
        }
    }

    // Synchronous and best-effort — the only caller is applicationWillTerminate, where the
    // run loop is about to die and an async hop to the queue would never complete.
    //
    // expectedPid is forwarded to `ghost undrive --pid`, which refuses to SIGINT unless the
    // live drive on that pane still has this exact pid — the only way Quit can tell "the
    // drive this app instance spawned" apart from an unrelated drive that took over the
    // same pane id in the meantime, CLI-started or otherwise (claim #13).
    func undriveBlocking(_ paneId: String, expectedPid: Int32) {
        run(["undrive", paneId, "--pid", String(expectedPid)])
    }
}
