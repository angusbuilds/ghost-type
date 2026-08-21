// GhostType — native macOS menu-bar app.
// The upper-toolbar session picker: 👻 in the menu bar, live tmux panes in the dropdown,
// click a pane to haunt it (turns purple, Ghost Type drives it), click again to release.
// No dock icon (LSUIElement). Shells to the existing tested CLI — this app is a thin,
// pretty face over `ghost sessions/haunt/unhaunt`.
import AppKit
import Foundation

// MARK: - Theme
enum Theme {
    static let purple = NSColor(red: 0x8b / 255.0, green: 0x5c / 255.0, blue: 0xf6 / 255.0, alpha: 1)
    static let purpleDeep = NSColor(red: 0x5a / 255.0, green: 0x2c / 255.0, blue: 0xa0 / 255.0, alpha: 1)
    static let muted = NSColor.secondaryLabelColor
    static let mono = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
    static let monoBold = NSFont.monospacedSystemFont(ofSize: