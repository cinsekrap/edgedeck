import AppKit
import ApplicationServices

/// Reads the red badge counts on Dock icons (unread mail, messages…) through
/// Accessibility: each Dock item exposes its badge text as "AXStatusLabel".
/// Only apps shown in the Dock (kept there or running) appear.
enum DockBadges {
    /// [{name, bundleID, badge}] for every app in the Dock, in Dock order.
    static func list() -> [[String: Any]] {
        guard AXIsProcessTrusted(),
              let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return [] }
        let root = AXUIElementCreateApplication(dock.processIdentifier)
        var out: [[String: Any]] = []
        for list in TeamsAccessibility.children(root) where TeamsAccessibility.string(list, kAXRoleAttribute as String) == "AXList" {
            for item in TeamsAccessibility.children(list) {
                guard TeamsAccessibility.string(item, kAXSubroleAttribute as String) == "AXApplicationDockItem",
                      let name = TeamsAccessibility.string(item, kAXTitleAttribute as String) else { continue }
                var bundleID = ""
                if let url = TeamsAccessibility.attribute(item, kAXURLAttribute as String) as? URL ?? (TeamsAccessibility.attribute(item, kAXURLAttribute as String) as? NSURL)?.absoluteURL,
                   let id = Bundle(url: url)?.bundleIdentifier {
                    bundleID = id
                }
                let badge = TeamsAccessibility.string(item, "AXStatusLabel") ?? ""
                out.append(["name": name, "bundleID": bundleID, "badge": badge])
            }
        }
        return out
    }
}
