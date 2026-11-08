import AppKit
import ApplicationServices

/// Reads Microsoft Teams' meeting controls through the macOS Accessibility
/// API. (Teams' local third-party API was retired by Microsoft on 30 June
/// 2026, MC1266901.) Teams renders its UI in a Chromium-based WebView2, which
/// only builds the web accessibility tree once an assistive app sets
/// AXManualAccessibility on it, and exposes each DOM element's id as
/// AXDOMIdentifier (e.g. "microphone-button", "hangup-button").
enum TeamsAccessibility {
    static let bundleID = "com.microsoft.teams2"

    static var teamsPID: pid_t? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first?.processIdentifier
    }

    // MARK: AX helpers

    static func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success ? value : nil
    }

    static func string(_ e: AXUIElement, _ name: String) -> String? {
        guard let s = attribute(e, name) as? String, !s.isEmpty else { return nil }
        return s
    }

    static func children(_ e: AXUIElement) -> [AXUIElement] {
        attribute(e, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
    }

    /// Asks Chromium to build its accessibility tree for the web content.
    @discardableResult
    static func enableWebAccessibility(_ app: AXUIElement) -> String {
        // Chromium builds its web accessibility tree when an assistive app sets either of these.
        let manual = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        let enhanced = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        return "AXManualAccessibility \(manual.rawValue), AXEnhancedUserInterface \(enhanced.rawValue)"
    }

    /// Counts elements under the app's windows (capped), for checking whether the web tree exists.
    static func countElements(_ app: AXUIElement, cap: Int = 20000) -> Int {
        var n = 0
        var stack = attribute(app, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
        while let e = stack.popLast(), n < cap {
            n += 1
            stack.append(contentsOf: children(e))
        }
        return n
    }

    // MARK: Diagnostics

    /// Logs Teams' windows, buttons and identified elements. Read-only.
    static func dumpToLog() {
        guard AXIsProcessTrusted() else {
            Log.write("Teams inspect: EdgeDeck doesn't have Accessibility permission")
            return
        }
        guard let pid = teamsPID else {
            Log.write("Teams inspect: Teams isn't running")
            return
        }
        let app = AXUIElementCreateApplication(pid)
        Log.write("Teams inspect: set attributes -> " + enableWebAccessibility(app) + " (0 = accepted)")
        for delay in [1.0, 4.0] {
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + delay) {
                Log.write("Teams inspect: \(countElements(app)) elements after \(Int(delay)) s")
            }
        }
        // Read after a short pause (the tree exists once Teams has been asked for it).
        // Start from the app's top-level children so pop-ups outside windows are included.
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 2) {
            var lines: [String] = []
            var visited = 0
            let windows = children(app)
            lines.append("Teams inspect: \(windows.count) window(s)")
            for (i, w) in windows.enumerated() {
                lines.append("Window \(i): \(string(w, kAXRoleAttribute as String) ?? "?") \"\(string(w, kAXTitleAttribute as String) ?? "")\"")
                var stack: [(AXUIElement, Int)] = [(w, 0)]
                while let (e, depth) = stack.popLast(), visited < 30000, lines.count < 600 {
                    visited += 1
                    let role = string(e, kAXRoleAttribute as String) ?? "?"
                    let id = string(e, "AXDOMIdentifier")
                    // Also anything describing you or a raised hand, whatever its role (e.g. your
                    // video tile, which carries the raised-hand state).
                    let words = ((string(e, kAXTitleAttribute as String) ?? "") + " " + (string(e, kAXDescriptionAttribute as String) ?? "")).lowercased()
                    let mentionsHand = words.contains("myself") || words.contains("hand") || words.contains("raised")
                    let interesting = id != nil || mentionsHand || ["AXButton", "AXCheckBox", "AXMenuButton", "AXRadioButton", "AXPopUpButton", "AXMenuItem"].contains(role)
                    if interesting {
                        var parts = ["  [\(depth)] \(role)"]
                        if let id = id { parts.append("id=\(id)") }
                        if let t = string(e, kAXTitleAttribute as String) { parts.append("title=\"\(t)\"") }
                        if let d = string(e, kAXDescriptionAttribute as String) { parts.append("desc=\"\(d)\"") }
                        if let h = string(e, kAXHelpAttribute as String) { parts.append("help=\"\(h)\"") }
                        if let v = attribute(e, kAXValueAttribute as String) { parts.append("value=\(v)") }
                        lines.append(parts.joined(separator: " "))
                    }
                    for c in children(e).reversed() where depth < 80 { stack.append((c, depth + 1)) }
                }
            }
            lines.append("Teams inspect: visited \(visited) elements")
            for line in lines { Log.write(line) }
        }
    }
}
