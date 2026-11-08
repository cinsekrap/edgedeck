import AppKit
import ApplicationServices

/// Zoom meeting controls through Accessibility. Zoom's menu bar (the Meeting
/// menu in particular) names its actions by what they would do ("Mute Audio" /
/// "Unmute Audio"), which gives both state and something to press.
enum ZoomAccessibility {
    static let bundleID = "us.zoom.xos"

    static var pid: pid_t? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first?.processIdentifier
    }

    // MARK: Diagnostics (Diagnostics → Inspect Zoom Menus)

    /// Logs Zoom's menus and the meeting window's buttons. Read-only: nothing is pressed.
    static func dumpToLog() {
        guard AXIsProcessTrusted() else { Log.write("Zoom inspect: EdgeDeck doesn't have Accessibility permission"); return }
        guard let pid = pid else { Log.write("Zoom inspect: Zoom isn't running"); return }
        let app = AXUIElementCreateApplication(pid)
        // Wait 5 s so a Zoom pop-up (React, Video options) can be opened after choosing this.
        Log.write("Zoom inspect: reading in 5 seconds — open the Zoom pop-up now")
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 5) {
            var lines: [String] = []
            let str = { (e: AXUIElement, a: String) in TeamsAccessibility.string(e, a) }

            // Menu bar: each menu and its items.
            if let bar = TeamsAccessibility.attribute(app, kAXMenuBarAttribute as String) {
                let barElement = bar as! AXUIElement
                for menuBarItem in TeamsAccessibility.children(barElement) {
                    let title = str(menuBarItem, kAXTitleAttribute as String) ?? "?"
                    var items: [String] = []
                    for menu in TeamsAccessibility.children(menuBarItem) {
                        for item in TeamsAccessibility.children(menu) {
                            guard let t = str(item, kAXTitleAttribute as String) else { continue }
                            var bits = ["\"\(t)\""]
                            if let enabled = TeamsAccessibility.attribute(item, kAXEnabledAttribute as String) as? Bool, !enabled { bits.append("disabled") }
                            if let mark = str(item, kAXMenuItemMarkCharAttribute as String) { bits.append("mark=\(mark)") }
                            if let key = str(item, kAXMenuItemCmdCharAttribute as String) { bits.append("key=\(key)") }
                            if !TeamsAccessibility.children(item).isEmpty { bits.append("submenu") }
                            items.append(bits.joined(separator: " "))
                        }
                    }
                    lines.append("Zoom inspect: menu \"\(title)\": " + (items.isEmpty ? "(empty)" : items.joined(separator: ", ")))
                }
            } else {
                lines.append("Zoom inspect: no menu bar found")
            }

            // Windows: titles, and their buttons (labels only).
            let windows = TeamsAccessibility.attribute(app, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
            for w in windows {
                lines.append("Zoom inspect: window \"\(str(w, kAXTitleAttribute as String) ?? "")\"")
                var stack = [w]
                var visited = 0
                var buttons: [String] = []
                while let e = stack.popLast(), visited < 8000, buttons.count < 200 {
                    visited += 1
                    let role = str(e, kAXRoleAttribute as String) ?? ""
                    if ["AXButton", "AXCheckBox", "AXMenuButton", "AXPopUpButton", "AXMenuItem", "AXRadioButton"].contains(role) {
                        let label = str(e, kAXTitleAttribute as String) ?? str(e, kAXDescriptionAttribute as String) ?? str(e, kAXHelpAttribute as String)
                        if let label = label {
                            var extra = ""
                            if let v = TeamsAccessibility.attribute(e, kAXValueAttribute as String) { extra += " value=\(v)" }
                            if let m = str(e, kAXMenuItemMarkCharAttribute as String) { extra += " mark=\(m)" }
                            buttons.append("\(role.dropFirst(2)) \"\(label)\"\(extra)")
                        }
                    }
                    stack.append(contentsOf: TeamsAccessibility.children(e))
                }
                lines.append("Zoom inspect:   \(visited) elements; buttons: " + buttons.joined(separator: ", "))
            }
            for line in lines { Log.write(line) }
        }
    }
}

/// Zoom meeting state and controls, read from and pressed through Zoom's menu
/// bar (checked on Zoom Workplace 7.2.5 for Mac, English UI, Nov 2026):
///   Meeting menu: "Mute audio"/"Unmute audio", "Start video"/"Stop video",
///                 "Start share"/"Stop share", "Record"/"Stop recording"
///   View menu:    "Show chat"/"Hide chat"
/// The audio item only exists during a meeting, which gives meeting detection.
/// Leaving uses the meeting window's "End"/"Leave" button and then the
/// confirmation's "Leave meeting" (never "End meeting for all").
/// Reactions and raise hand live in the pop-up opened by the window's "React"
/// button (a window titled "Menu window"): buttons labelled "👍, Option+Command+5",
/// "✋ Raise hand, Option+Y" (or "Lower hand") and so on. Blur is the checkbox
/// "Blur my background" (AXValue 0/1) in the pop-up opened by "Video options". Zoom hides its meeting
/// toolbar (React, End) until the mouse is over the window, and hidden buttons
/// aren't in the accessibility tree. When they can't be found, EdgeDeck briefly
/// turns on Window → "Always Show Meeting Controls" (a menu item, so always
/// reachable), presses the button, and turns the setting back off. Zoom's own
/// shortcuts (⌥⌘4–8 reactions, ⌥Y raise hand) are a last resort; they only
/// work if Zoom accepts keys while in the background.
/// Publishes the same state shape as TeamsAXClient, with app "Zoom".
final class ZoomAXClient {
    var onUpdate: (() -> Void)?

    private let queue = DispatchQueue(label: "edgedeck.zoom")
    private var timer: DispatchSourceTimer?
    private var items: [String: AXUIElement] = [:]   // lowercased menu title -> item
    private var app: AXUIElement?
    private var appPID: pid_t?
    private var published: [String: Any] = ZoomAXClient.idle(reason: "starting")
    private var publishedKey = ""
    private var lastInMeeting = false
    /// When the meeting's menu items were last seen. Zoom sometimes rebuilds its
    /// menus, so a meeting only ends after they've been missing for 3 seconds.
    private var lastSeenInMeeting: Date?
    /// Raise-hand state is only visible while the React pop-up is open, so this
    /// is what EdgeDeck last saw there (reset when the meeting ends).
    private var handRaised = false
    /// Blur state as last read from the Video options pop-up (reset when the meeting ends).
    private var blurOn = false
    /// True while a pop-up action (reaction, raise hand) is running.
    private var popupBusy = false

    var state: [String: Any] { published }

    private static func idle(reason: String) -> [String: Any] {
        ["connected": false, "paired": true, "source": "accessibility", "app": "Zoom", "reason": reason, "meeting": [String: Any]()]
    }

    func start() {
        queue.async { [weak self] in
            guard let self = self, self.timer == nil else { return }
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now(), repeating: 1.0, leeway: .milliseconds(200))
            t.setEventHandler { [weak self] in self?.poll() }
            t.resume()
            self.timer = t
        }
    }

    func stop() {
        queue.async {
            self.timer?.cancel()
            self.timer = nil
            self.publish(Self.idle(reason: "off"))
        }
    }

    // MARK: Polling (on queue)

    private func poll() {
        // A momentary blip (Zoom briefly not found, menus being rebuilt) shouldn't end
        // the meeting: wait until the meeting has been gone for 3 seconds.
        let withinGrace = lastSeenInMeeting.map { Date().timeIntervalSince($0) < 3 } ?? false
        guard AXIsProcessTrusted() else { if !withinGrace { publish(Self.idle(reason: "accessibility")) }; return }
        guard let pid = ZoomAccessibility.pid else {
            app = nil; appPID = nil
            if !withinGrace { lastSeenInMeeting = nil; handRaised = false; publish(Self.idle(reason: "not running")) }
            return
        }
        if pid != appPID { appPID = pid; app = AXUIElementCreateApplication(pid) }
        items = readMenus(["Meeting", "View"])
        let has = { (t: String) in self.items[t] != nil }
        let inMeeting = has("mute audio") || has("unmute audio")
        if inMeeting {
            lastSeenInMeeting = Date()
        } else if let seen = lastSeenInMeeting, Date().timeIntervalSince(seen) < 3 {
            return   // probably a menu rebuild: keep the last state for now
        } else {
            lastSeenInMeeting = nil
            handRaised = false
            blurOn = false
        }
        let meeting: [String: Any] = [
            "isInMeeting": inMeeting,
            "isMuted": has("unmute audio"),
            "isVideoOn": has("stop video"),
            "isSharing": has("stop share"),
            "isRecordingOn": has("stop recording") || has("pause recording"),
            "isHandRaised": handRaised,
            "isBackgroundBlurred": blurOn,
            "hasUnreadMessages": false,
            "canToggleMute": inMeeting,
            "canToggleVideo": has("start video") || has("stop video"),
            "canStopSharing": has("stop share"),
            "canToggleChat": inMeeting && (has("show chat") || has("hide chat")),
            "canLeave": inMeeting,
            "canToggleHand": inMeeting,
            "canReact": inMeeting,
            "canToggleBlur": inMeeting,
        ]
        publish(["connected": true, "paired": true, "source": "accessibility", "app": "Zoom", "meeting": meeting])
    }

    /// Items of the named menu-bar menus, keyed by lowercased title.
    private func readMenus(_ names: Set<String>) -> [String: AXUIElement] {
        guard let app = app, let barRef = TeamsAccessibility.attribute(app, kAXMenuBarAttribute as String) else { return [:] }
        let bar = barRef as! AXUIElement
        var found: [String: AXUIElement] = [:]
        for barItem in TeamsAccessibility.children(bar) {
            guard let title = TeamsAccessibility.string(barItem, kAXTitleAttribute as String), names.contains(title) else { continue }
            for menu in TeamsAccessibility.children(barItem) {
                for item in TeamsAccessibility.children(menu) {
                    if let t = TeamsAccessibility.string(item, kAXTitleAttribute as String) { found[t.lowercased()] = item }
                }
            }
        }
        return found
    }

    private func publish(_ s: [String: Any]) {
        let key = JSON.string(s)
        guard key != publishedKey else { return }
        let isIn = (s["meeting"] as? [String: Any])?["isInMeeting"] as? Bool ?? false
        if isIn != lastInMeeting {
            let why = (s["reason"] as? String).map { " (\($0))" } ?? " (menu items: \(items.keys.sorted().joined(separator: ", ")))"
            Log.write((isIn ? "Zoom: meeting started" : "Zoom: meeting ended") + (isIn ? "" : why))
        }
        lastInMeeting = isIn
        publishedKey = key
        DispatchQueue.main.async {
            self.published = s
            self.onUpdate?()
        }
    }

    // MARK: Actions

    private static let menuActions: [String: [String]] = [
        "toggle-mute": ["mute audio", "unmute audio"],
        "toggle-video": ["start video", "stop video"],
        "stop-sharing": ["stop share"],
        "toggle-ui": ["show chat", "hide chat"],
    ]

    @discardableResult
    func send(action: String, type: String? = nil) -> String? {
        if let reason = published["reason"] as? String {
            return reason == "accessibility" ? "EdgeDeck needs Accessibility permission to control Zoom"
                : reason == "not running" ? "Zoom isn't open" : "Zoom control is off"
        }
        if action == "leave-call" { queue.async { self.leave() }; return nil }
        if action == "send-reaction" {
            guard let emoji = Self.reactionEmoji[type ?? "like"] else { return "Unknown reaction" }
            return popupAction(shortcut: Self.reactionKeys[type ?? "like"]) { label in label.hasPrefix(emoji + ",") }
        }
        if action == "toggle-background-blur" { return toggleBlur() }
        if action == "toggle-hand" {
            return popupAction(shortcut: (16, [.maskAlternate])) { label in label.contains("raise hand") || label.contains("lower hand") }
        }
        guard let titles = Self.menuActions[action] else { return "That control isn't available for Zoom yet" }
        guard let item = queue.sync(execute: { titles.lazy.compactMap { self.items[$0] }.first }) else {
            return "That Zoom control isn't available right now"
        }
        queue.async {
            let r = AXUIElementPerformAction(item, kAXPressAction as CFString)
            if r != .success { Log.write("Zoom: pressing \(titles.first ?? action) failed (\(r.rawValue))") }
            self.queue.asyncAfter(deadline: .now() + 0.3) { self.poll() }
        }
        return nil
    }

    /// The widget's reaction names -> the emoji Zoom labels its buttons with.
    private static let reactionEmoji = ["like": "👍", "love": "❤️", "applause": "👏", "laugh": "😂", "wow": "😮"]
    /// ...and Zoom's shortcuts for them (⌥⌘ + 4–8; virtual key codes).
    private static let reactionKeys: [String: (CGKeyCode, CGEventFlags)] = [
        "applause": (21, [.maskAlternate, .maskCommand]), "like": (23, [.maskAlternate, .maskCommand]),
        "love": (22, [.maskAlternate, .maskCommand]), "laugh": (26, [.maskAlternate, .maskCommand]),
        "wow": (28, [.maskAlternate, .maskCommand]),
    ]

    /// Runs `body` with Zoom's meeting toolbar showing: if `ready` finds nothing,
    /// turns on Window → "Always Show Meeting Controls", waits for the toolbar,
    /// runs `body`, then turns the setting back off. Returns false if the
    /// toolbar couldn't be shown. On queue.
    private func withToolbar(ready: () -> Bool, _ body: () -> Void) -> Bool {
        if ready() { body(); return true }
        guard let item = readMenus(["Window"])["always show meeting controls"] else { return false }
        let wasOn = TeamsAccessibility.string(item, kAXMenuItemMarkCharAttribute as String) != nil
        if !wasOn { AXUIElementPerformAction(item, kAXPressAction as CFString) }
        var shown = false
        for _ in 0..<12 {
            Thread.sleep(forTimeInterval: 0.1)
            if ready() { shown = true; break }
        }
        if shown { body() }
        if !wasOn, let again = readMenus(["Window"])["always show meeting controls"] {
            AXUIElementPerformAction(again, kAXPressAction as CFString)   // put Zoom back as it was
        }
        return shown
    }

    /// Sends a keystroke straight to Zoom (it doesn't need to be in front). On queue.
    private func postKey(_ key: CGKeyCode, _ flags: CGEventFlags) {
        guard let pid = appPID else { return }
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down)
            e?.flags = flags
            e?.postToPid(pid)
        }
    }

    private static func label(_ e: AXUIElement) -> String {
        (TeamsAccessibility.string(e, kAXTitleAttribute as String) ?? TeamsAccessibility.string(e, kAXDescriptionAttribute as String) ?? "").lowercased()
    }

    /// The first button in any Zoom window whose (lowercased) label matches. On queue.
    private func findButton(_ match: (String) -> Bool) -> AXUIElement? {
        findElement(roles: ["AXButton"], match)
    }

    private func findElement(roles: Set<String>, _ match: (String) -> Bool) -> AXUIElement? {
        guard let app = app else { return nil }
        for w in TeamsAccessibility.attribute(app, kAXWindowsAttribute as String) as? [AXUIElement] ?? [] {
            var stack = [w]
            var visited = 0
            while let e = stack.popLast(), visited < 4000 {
                visited += 1
                if let role = TeamsAccessibility.string(e, kAXRoleAttribute as String), roles.contains(role), match(Self.label(e)) { return e }
                stack.append(contentsOf: TeamsAccessibility.children(e))
            }
        }
        return nil
    }

    /// Opens the React pop-up (unless it's already open), presses the button
    /// whose label matches, and closes the pop-up with Escape sent to Zoom. If
    /// the toolbar is hidden (no React button), sends `shortcut` instead.
    private func popupAction(shortcut: (CGKeyCode, CGEventFlags)?, _ match: @escaping (String) -> Bool) -> String? {
        let started: Bool = queue.sync {
            if popupBusy { return false }
            popupBusy = true
            return true
        }
        guard started else { return nil }   // an earlier tap is still being handled
        queue.async {
            defer {
                self.popupBusy = false
                self.queue.asyncAfter(deadline: .now() + 0.3) { self.poll() }
            }
            var target = self.findButton(match)
            if target == nil {
                // Open the React pop-up, showing the toolbar first if it's hidden.
                let opened = self.withToolbar(ready: { self.findButton({ $0 == "react" }) != nil }) {
                    if let react = self.findButton({ $0 == "react" }) {
                        AXUIElementPerformAction(react, kAXPressAction as CFString)
                    }
                    for _ in 0..<12 {
                        Thread.sleep(forTimeInterval: 0.1)
                        target = self.findButton(match)
                        if target != nil { break }
                    }
                }
                if !opened {
                    // Last resort: Zoom's keyboard shortcut.
                    guard let (key, flags) = shortcut else { Log.write("Zoom: couldn't find the React button"); return }
                    self.postKey(key, flags)
                    if key == 16 { self.handRaised.toggle() }   // ⌥Y: can't read the result, so follow our own tap
                    return
                }
            }
            guard let button = target else {
                Log.write("Zoom: the React pop-up didn't show the button")
                return
            }
            let text = Self.label(button)
            AXUIElementPerformAction(button, kAXPressAction as CFString)
            if text.contains("raise hand") { self.handRaised = true }
            if text.contains("lower hand") { self.handRaised = false }
            // Close the pop-up if it's still open.
            Thread.sleep(forTimeInterval: 0.3)
            for _ in 0..<3 {
                guard self.findButton(match) != nil, let pid = self.appPID else { break }
                for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: down)?.postToPid(pid) }
                Thread.sleep(forTimeInterval: 0.25)
            }
        }
        return nil
    }

    /// Opens Video options (showing the toolbar if needed), reads and toggles the
    /// "Blur my background" checkbox, and closes the pop-up.
    private func toggleBlur() -> String? {
        let started: Bool = queue.sync {
            if popupBusy { return false }
            popupBusy = true
            return true
        }
        guard started else { return nil }
        queue.async {
            defer {
                self.popupBusy = false
                self.queue.asyncAfter(deadline: .now() + 0.3) { self.poll() }
            }
            let isBlur = { (label: String) in label.contains("blur my background") }
            var box = self.findElement(roles: ["AXCheckBox"], isBlur)
            if box == nil {
                _ = self.withToolbar(ready: { self.findButton({ $0 == "video options" }) != nil }) {
                    if let opener = self.findButton({ $0 == "video options" }) {
                        AXUIElementPerformAction(opener, kAXPressAction as CFString)
                    }
                    for _ in 0..<12 {
                        Thread.sleep(forTimeInterval: 0.1)
                        box = self.findElement(roles: ["AXCheckBox"], isBlur)
                        if box != nil { break }
                    }
                }
            }
            guard let checkbox = box else {
                Log.write("Zoom: Video options didn't show \"Blur my background\"")
                return
            }
            let wasOn = (TeamsAccessibility.attribute(checkbox, kAXValueAttribute as String) as? NSNumber)?.boolValue ?? false
            AXUIElementPerformAction(checkbox, kAXPressAction as CFString)
            self.blurOn = !wasOn
            Log.write("Zoom: background blur \(wasOn ? "off" : "on")")
            Thread.sleep(forTimeInterval: 0.3)
            for _ in 0..<3 {
                guard self.findElement(roles: ["AXCheckBox"], isBlur) != nil, let pid = self.appPID else { break }
                for down in [true, false] { CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: down)?.postToPid(pid) }
                Thread.sleep(forTimeInterval: 0.25)
            }
        }
        return nil
    }

    /// Presses the meeting window's End/Leave button, then "Leave meeting" in
    /// the confirmation. Never presses "End meeting for all". On queue.
    private func leave() {
        let isEnd = { (label: String) in label == "end" || label == "leave" }
        let pressed = withToolbar(ready: { findButton(isEnd) != nil }) {
            if let end = findButton(isEnd) { AXUIElementPerformAction(end, kAXPressAction as CFString) }
        }
        guard pressed else {
            Log.write("Zoom: couldn't show the meeting controls to find End/Leave")
            return
        }
        for _ in 0..<15 {
            Thread.sleep(forTimeInterval: 0.1)
            if let confirm = findButton({ $0 == "leave meeting" }) {
                AXUIElementPerformAction(confirm, kAXPressAction as CFString)
                Log.write("Zoom: left the meeting")
                queue.asyncAfter(deadline: .now() + 0.5) { self.poll() }
                return
            }
        }
        Log.write("Zoom: no \"Leave meeting\" option appeared; left the confirmation open")
    }
}

/// Combines the Teams and Zoom clients into one meeting source: whichever app
/// is in a meeting drives the meeting widget, page switching and lights;
/// otherwise Teams' status is shown. Actions go to that same app.
final class MeetingHub {
    let teams = TeamsAXClient()
    let zoom = ZoomAXClient()
    var onUpdate: (() -> Void)?

    init() {
        teams.onUpdate = { [weak self] in self?.onUpdate?() }
        zoom.onUpdate = { [weak self] in self?.onUpdate?() }
    }

    func start() { teams.start(); zoom.start() }
    func stop() { teams.stop(); zoom.stop() }

    private var zoomInMeeting: Bool {
        (zoom.state["meeting"] as? [String: Any])?["isInMeeting"] as? Bool ?? false
    }

    var state: [String: Any] {
        if zoomInMeeting { return zoom.state }
        var s = teams.state
        s["app"] = "Teams"
        return s
    }

    @discardableResult
    func send(action: String, type: String? = nil) -> String? {
        zoomInMeeting ? zoom.send(action: action, type: type) : teams.send(action: action, type: type)
    }
}
