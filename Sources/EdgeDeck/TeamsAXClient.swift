import AppKit
import ApplicationServices

/// Microsoft Teams meeting state and controls through the Accessibility API,
/// replacing Teams' local third-party API (retired 30 June 2026, MC1266901).
///
/// Teams' meeting toolbar buttons carry stable DOM ids, exposed as
/// AXDOMIdentifier, and their titles say what pressing them would do, which
/// gives the current state (checked on new Teams for Mac, Nov 2026, English UI):
///   microphone-button  "Mute mic" / "Unmute mic"
///   video-button       "Turn camera off" / "Turn camera on"
///   raisehands-button  "Raise your hand" / "Lower your hand"
///   share-button       "Share content" / "Stop sharing"
///   hangup-button      "Leave" (only exists during a meeting)
///   (Newer Teams labels the hand button just "Raise" whether or not the hand is
///   up; the state is in your own video tile's description, which starts
///   "Myself video, …" and includes "Hand raised" while it is. With the camera
///   off in a meeting on your own there's no tile, so EdgeDeck falls back to the
///   state from its own last tap.)
///   reaction-menu-button "React" opens a pop-up with like-button, heart-button,
///   applause-button, laugh-button, surprised-button (the rest of the meeting
///   window is hidden from Accessibility while it is open)
///   video-button-configure "Open video options" opens a menu of background
///   effects as AXMenuItems, e.g. "Standard blur" and "No background effect"
///   (shown as "None"); the current one has AXValue 1 and mark char "✓".
/// This isn't a published Microsoft interface, so a Teams redesign could break
/// it; Diagnostics → Inspect Teams Controls logs what Teams currently exposes.
///
/// Publishes the same shape the old client did, so the dashboard is unchanged:
///   {connected, paired, source, reason?, meeting: {isInMeeting, isMuted, …, canToggleMute, …}}
final class TeamsAXClient {
    /// Called on the main thread when the published state changes.
    var onUpdate: (() -> Void)?

    private let queue = DispatchQueue(label: "edgedeck.teams")
    private var timer: DispatchSourceTimer?
    private var pid: pid_t?
    private var app: AXUIElement?
    private var buttons: [String: AXUIElement] = [:]
    private var lastScan = Date.distantPast
    private var published: [String: Any] = TeamsAXClient.offline(reason: "starting")
    private var publishedKey = ""
    private var lastInMeeting = false   // queue-only copy, for logging transitions
    /// Hand state from EdgeDeck's own last raise/lower tap, used when your video
    /// tile (the real source) isn't showing. Cleared when the meeting ends.
    private var tappedHand: Bool?
    private var unavailableSince: Date?
    /// The window the meeting controls were last seen in, its title, and the last
    /// full set of button labels. A pop-up such as React hides the toolbar from
    /// Accessibility; while that window is still open we keep reporting the meeting.
    private var meetingWindow: (element: AXUIElement, title: String)?
    private var lastMeetingTitles: [String: String] = [:]
    private var toolbarHiddenSince: Date?
    /// Blur state can only be read while the video options menu is open, so
    /// this is what EdgeDeck last read there (nil = unknown).
    private var blurOn: Bool?
    /// True while a menu-driven action (blur, reaction) is running; further taps are ignored.
    private var menuBusy = false

    private static let watchedIDs: Set<String> = ["microphone-button", "video-button", "raisehands-button",
                                                  "hangup-button", "share-button", "chat-button", "reaction-menu-button",
                                                  "video-button-configure"]
    /// Reaction names used by the dashboard -> button ids in Teams' React pop-up.
    private static let reactionIDs = ["like": "like-button", "love": "heart-button", "applause": "applause-button",
                                      "laugh": "laugh-button", "wow": "surprised-button"]
    private static let actionTargets = ["toggle-mute": "microphone-button", "toggle-video": "video-button",
                                        "toggle-hand": "raisehands-button", "leave-call": "hangup-button",
                                        "stop-sharing": "share-button", "toggle-ui": "chat-button"]

    /// The latest published state (read on the main thread).
    var state: [String: Any] { published }

    private static func offline(reason: String) -> [String: Any] {
        ["connected": false, "paired": true, "source": "accessibility", "reason": reason, "meeting": [String: Any]()]
    }

    // MARK: Lifecycle

    func start() {
        queue.async { [weak self] in
            guard let self = self, self.timer == nil else { return }
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now(), repeating: 1.0, leeway: .milliseconds(200))
            t.setEventHandler { [weak self] in self?.poll() }
            t.resume()
            self.timer = t
            Log.write("Teams: watching through Accessibility")
        }
    }

    func stop() {
        queue.async {
            self.timer?.cancel()
            self.timer = nil
            self.reset()
            self.publish(Self.offline(reason: "off"))
        }
    }

    private func reset() {
        pid = nil
        app = nil
        buttons = [:]
        lastScan = .distantPast
        meetingWindow = nil
        lastMeetingTitles = [:]
        toolbarHiddenSince = nil
        blurOn = nil
    }

    // MARK: Polling (on queue)

    private func poll() {
        // A momentary blip (Teams briefly not found, e.g. while EdgeDeck starts up)
        // shouldn't end a meeting: wait until it has lasted 5 seconds.
        if !AXIsProcessTrusted() || TeamsAccessibility.teamsPID == nil {
            let since = unavailableSince ?? Date()
            unavailableSince = since
            if !lastMeetingTitles.isEmpty && Date().timeIntervalSince(since) < 5 { return }
        } else {
            unavailableSince = nil
        }
        guard AXIsProcessTrusted() else { reset(); publish(Self.offline(reason: "accessibility")); return }
        guard let p = TeamsAccessibility.teamsPID else { reset(); publish(Self.offline(reason: "not running")); return }
        if p != pid {
            reset()
            pid = p
            let a = AXUIElementCreateApplication(p)
            app = a
            TeamsAccessibility.enableWebAccessibility(a)
        }

        var titles = readTitles()
        // Look for the controls every 3 s while not in a meeting, and every 15 s
        // during one in case buttons appear (e.g. chat once others join).
        // Not in a meeting: look every 3 s. In one: every 15 s, or every 5 s while your
        // own video tile (which carries the raised-hand state) hasn't been found.
        let interval: TimeInterval = titles["hangup-button"] == nil ? 3 : titles["self-tile"] == nil ? 5 : 15
        // If we were in a meeting and the cached Leave button just stopped answering,
        // Teams has probably re-rendered its toolbar: search again now, not in 3 s.
        let lostButtons = titles["hangup-button"] == nil && !lastMeetingTitles.isEmpty
        if lostButtons || Date().timeIntervalSince(lastScan) > interval {
            // Ask again each time: if Teams was still starting up when it was first
            // asked, its web view may not have existed yet and the request was lost.
            if titles["hangup-button"] == nil, let a = app { TeamsAccessibility.enableWebAccessibility(a) }
            scan()
            lastScan = Date()
            titles = readTitles()
        }
        let resolved = resolveMeeting(titles)
        logTitlesIfChanged(resolved)
        if resolved["hangup-button"] == nil { tappedHand = nil }   // meeting over: forget the tap
        if resolved["hangup-button"] == nil { blurOn = nil }   // forget blur once the meeting is over
        var state = Self.makeState(resolved, tappedHand: tappedHand)
        if var m = state["meeting"] as? [String: Any] {
            m["isBackgroundBlurred"] = blurOn ?? false
            state["meeting"] = m
        }
        publish(state)
    }

    /// Bridges gaps where the toolbar is hidden (e.g. the React pop-up is open):
    /// if the meeting window is still open with the same title, carry on with
    /// the last known labels, for up to 5 minutes.
    private func resolveMeeting(_ titles: [String: String]) -> [String: String] {
        if titles["hangup-button"] != nil {
            lastMeetingTitles = titles
            toolbarHiddenSince = nil
            return titles
        }
        guard !lastMeetingTitles.isEmpty else { return titles }
        let since = toolbarHiddenSince ?? Date()
        toolbarHiddenSince = since
        // Whatever the reason the Leave button has gone, give it 5 seconds to come back.
        if Date().timeIntervalSince(since) < 5 { return lastMeetingTitles }
        let currentTitle = meetingWindow.flatMap { TeamsAccessibility.string($0.element, kAXTitleAttribute as String) }
        guard let w = meetingWindow, currentTitle == w.title else {
            Log.write("Teams: Leave button gone for 5 s; meeting window " +
                      (meetingWindow == nil ? "unknown" : currentTitle == nil ? "closed" : "retitled"))   // titles hold meeting names: not logged
            meetingWindow = nil
            lastMeetingTitles = [:]
            toolbarHiddenSince = nil
            return titles
        }
        guard Date().timeIntervalSince(since) < 300 else {
            meetingWindow = nil
            lastMeetingTitles = [:]
            toolbarHiddenSince = nil
            return titles
        }
        return lastMeetingTitles
    }

    /// Reads the cached buttons' labels, dropping any that no longer exist.
    private func readTitles() -> [String: String] {
        var titles: [String: String] = [:]
        for (id, element) in buttons {
            if let t = TeamsAccessibility.string(element, kAXTitleAttribute as String)
                ?? TeamsAccessibility.string(element, kAXDescriptionAttribute as String) {
                titles[id] = t
            } else {
                buttons[id] = nil
            }
        }
        return titles
    }

    /// Walks Teams' windows for the meeting controls, meeting-like windows first.
    private func scan() {
        guard let app = app else { return }
        var windows = TeamsAccessibility.attribute(app, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
        windows.sort { a, _ in (TeamsAccessibility.string(a, kAXTitleAttribute as String) ?? "").localizedCaseInsensitiveContains("meeting") }
        var found: [String: AXUIElement] = [:]
        for w in windows {
            var stack = [w]
            var visited = 0
            while let e = stack.popLast(), visited < 8000 {
                visited += 1
                if let id = TeamsAccessibility.string(e, "AXDOMIdentifier"), Self.watchedIDs.contains(id), found[id] == nil {
                    found[id] = e
                } else if found["self-tile"] == nil,
                          let t = TeamsAccessibility.string(e, kAXTitleAttribute as String), t.hasPrefix("Myself video") {
                    found["self-tile"] = e   // your own video tile; its description says "Hand raised"
                }
                stack.append(contentsOf: TeamsAccessibility.children(e))
            }
            if found["hangup-button"] != nil {   // the meeting window: done
                meetingWindow = (w, TeamsAccessibility.string(w, kAXTitleAttribute as String) ?? "")
                break
            }
        }
        buttons = found
    }

    /// The button label (older Teams), else your video tile, else EdgeDeck's own last tap.
    private static func handRaised(_ lower: [String: String], tapped: Bool?) -> Bool {
        if lower["raisehands-button"]?.contains("lower") == true { return true }
        if let tile = lower["self-tile"] { return tile.contains("hand raised") }
        return tapped ?? false
    }

    private static func makeState(_ t: [String: String], tappedHand: Bool?) -> [String: Any] {
        let lower = t.mapValues { $0.lowercased() }
        let meeting: [String: Any] = [
            "isInMeeting": t["hangup-button"] != nil,
            "isMuted": lower["microphone-button"]?.contains("unmute") ?? false,
            "isVideoOn": lower["video-button"].map(cameraIsOn) ?? false,
            "isHandRaised": handRaised(lower, tapped: tappedHand),
            "isSharing": lower["share-button"]?.contains("stop") ?? false,
            "isRecordingOn": false,
            "isBackgroundBlurred": false,
            "hasUnreadMessages": false,
            "canToggleMute": t["microphone-button"] != nil,
            "canToggleVideo": t["video-button"] != nil,
            "canToggleHand": t["raisehands-button"] != nil,
            "canLeave": t["hangup-button"] != nil,
            "canStopSharing": lower["share-button"]?.contains("stop") ?? false,
            "canToggleChat": t["chat-button"] != nil,
            "canReact": t["reaction-menu-button"] != nil,
            "canToggleBlur": t["video-button-configure"] != nil,
        ]
        return ["connected": true, "paired": true, "source": "accessibility", "meeting": meeting]
    }

    /// The camera button says what pressing it would do ("Turn camera on" while
    /// the camera is off). Use the first whole word "on"/"off", wherever it is,
    /// so extra text such as a shortcut hint doesn't flip the result.
    private static func cameraIsOn(_ label: String) -> Bool {
        let words = label.split(whereSeparator: { !$0.isLetter }).map(String.init)
        if let word = words.first(where: { $0 == "on" || $0 == "off" }) { return word == "off" }
        return false
    }

    private var lastLoggedTitles: [String: String] = [:]

    /// Logs the toolbar labels when they change, so state-reading problems can be traced.
    private func logTitlesIfChanged(_ titles: [String: String]) {
        // Your own video tile's description includes your name; only its hand state matters here.
        var shown = titles
        if let tile = shown["self-tile"] { shown["self-tile"] = tile.lowercased().contains("hand raised") ? "hand raised" : "hand down" }
        guard shown != lastLoggedTitles, !shown.isEmpty else { return }
        lastLoggedTitles = shown
        Log.write("Teams: controls " + shown.keys.sorted().map { "\($0)=\"\(shown[$0]!)\"" }.joined(separator: ", "))
    }

    private func publish(_ s: [String: Any]) {
        let key = JSON.string(s)
        guard key != publishedKey else { return }
        let isIn = (s["meeting"] as? [String: Any])?["isInMeeting"] as? Bool ?? false
        if lastInMeeting != isIn { Log.write(isIn ? "Teams: meeting started" : "Teams: meeting ended") }
        lastInMeeting = isIn
        publishedKey = key
        DispatchQueue.main.async {
            self.published = s
            self.onUpdate?()
        }
    }

    // MARK: Actions

    /// Presses the matching Teams button. Returns an error message if it can't.
    @discardableResult
    func send(action: String, type: String? = nil) -> String? {
        if let reason = published["reason"] as? String {
            return reason == "accessibility" ? "EdgeDeck needs Accessibility permission to control Teams"
                : reason == "not running" ? "Teams isn't open" : "Teams control is off"
        }
        if action == "send-reaction" { return sendReaction(type ?? "like") }
        if action == "toggle-background-blur" { return toggleBlur() }
        guard let id = Self.actionTargets[action] else { return "Unknown Teams action \(action)" }
        guard let element = queue.sync(execute: { buttons[id] }) else {
            return "That Teams button isn't showing right now"
        }
        if action == "toggle-hand" {
            // Remember the tap, for when the video tile isn't there to report the real state.
            let current = (published["meeting"] as? [String: Any])?["isHandRaised"] as? Bool ?? false
            queue.sync { tappedHand = !current }
        }
        let previous = NSWorkspace.shared.frontmostApplication
        queue.async {
            let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
            if result != .success { Log.write("Teams: pressing \(id) failed (\(result.rawValue))") }
            self.queue.asyncAfter(deadline: .now() + 0.3) { self.poll() }
        }
        restoreFront(previous, after: 0.3)
        return nil
    }

    /// AXPress can bring Teams to the front; put back whatever was in front before.
    private func restoreFront(_ previous: NSRunningApplication?, after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard let previous = previous, previous.bundleIdentifier != TeamsAccessibility.bundleID,
                  NSWorkspace.shared.frontmostApplication?.bundleIdentifier == TeamsAccessibility.bundleID else { return }
            previous.activate(options: [])
        }
    }

    /// Opens the React pop-up, presses the reaction, and makes sure the pop-up closes.
    private func sendReaction(_ type: String) -> String? {
        guard let reactionID = Self.reactionIDs[type] else { return "Unknown reaction \(type)" }
        guard let menu = queue.sync(execute: { buttons["reaction-menu-button"] }) else {
            return "Teams' React button isn't showing right now"
        }
        let previous = NSWorkspace.shared.frontmostApplication
        restoreFront(previous, after: 1.2)
        return runMenuAction {
            // Use the pop-up if it's already open; otherwise open it and wait (up to 1 s).
            var reaction = self.findInMeetingWindow(reactionID)
            if reaction == nil {
                AXUIElementPerformAction(menu, kAXPressAction as CFString)
                for _ in 0..<10 {
                    Thread.sleep(forTimeInterval: 0.1)
                    reaction = self.findInMeetingWindow(reactionID)
                    if reaction != nil { break }
                }
            }
            guard let button = reaction else {
                Log.write("Teams: React pop-up didn't show \(reactionID)")
                return
            }
            AXUIElementPerformAction(button, kAXPressAction as CFString)
            Thread.sleep(forTimeInterval: 0.4)
            self.closeMenu { self.findInMeetingWindow(reactionID) != nil }
        }
    }

    /// Sends Escape straight to Teams until `stillOpen` is false (at most 3 tries). On queue.
    private func closeMenu(_ stillOpen: () -> Bool) {
        for _ in 0..<3 {
            guard stillOpen(), let pid = pid else { return }
            for down in [true, false] {
                CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: down)?.postToPid(pid)
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
    }

    /// Runs a menu-driven action on the queue unless one is already running.
    private func runMenuAction(_ work: @escaping () -> Void) -> String? {
        let started: Bool = queue.sync {
            if menuBusy { return false }
            menuBusy = true
            return true
        }
        guard started else { return nil }   // a previous tap is still being handled
        queue.async {
            work()
            self.menuBusy = false
            self.queue.asyncAfter(deadline: .now() + 0.3) { self.poll() }
        }
        return nil
    }

    /// Opens video options, reads whether blur is the current effect, presses
    /// "No background effect" or "… blur" accordingly, and closes the menu.
    private func toggleBlur() -> String? {
        guard let menu = queue.sync(execute: { buttons["video-button-configure"] }) else {
            return "Teams' video options button isn't showing right now"
        }
        let previous = NSWorkspace.shared.frontmostApplication
        restoreFront(previous, after: 1.2)
        return runMenuAction {
            let title: (AXUIElement) -> String = { (TeamsAccessibility.string($0, kAXTitleAttribute as String) ?? "").lowercased() }
            let isMenuItem: (AXUIElement) -> Bool = { TeamsAccessibility.string($0, kAXRoleAttribute as String) == "AXMenuItem" }
            let isBlurItem: (AXUIElement) -> Bool = { isMenuItem($0) && title($0).contains("blur") }
            let isNoneItem: (AXUIElement) -> Bool = { isMenuItem($0) && (title($0) == "none" || title($0).hasPrefix("no background effect")) }
            let isCurrent: (AXUIElement) -> Bool = {
                (TeamsAccessibility.attribute($0, kAXValueAttribute as String) as? NSNumber)?.boolValue == true ||
                    TeamsAccessibility.string($0, kAXMenuItemMarkCharAttribute as String) != nil
            }
            // If the menu is already open (e.g. left open earlier), use it rather than toggling it shut.
            var blurItem = self.findInMeetingWindow(where: isBlurItem)
            if blurItem == nil {
                AXUIElementPerformAction(menu, kAXPressAction as CFString)
                for _ in 0..<10 {
                    Thread.sleep(forTimeInterval: 0.1)
                    blurItem = self.findInMeetingWindow(where: isBlurItem)
                    if blurItem != nil { break }
                }
            }
            if let blurItem = blurItem {
                let isOn = isCurrent(blurItem)
                if let target = isOn ? self.findInMeetingWindow(where: isNoneItem) : blurItem {
                    AXUIElementPerformAction(target, kAXPressAction as CFString)
                    self.blurOn = !isOn
                    Log.write("Teams: background blur \(isOn ? "off" : "on")")
                } else {
                    self.blurOn = isOn
                    self.logMenuItems()
                    Log.write("Teams: video options didn't show \"No background effect\"")
                }
            } else {
                self.logMenuItems()
                Log.write("Teams: video options didn't show a blur option")
            }
            Thread.sleep(forTimeInterval: 0.3)
            self.closeMenu { self.findInMeetingWindow(where: isBlurItem) != nil }
        }
    }

    /// Logs the menu items currently showing in the meeting window (titles and values), to
    /// help spot a reliable "selected" signal for background effects. On queue.
    private func logMenuItems() {
        guard let root = meetingWindow?.element else { return }
        var items: [String] = []
        var stack = [root]
        var visited = 0
        while let e = stack.popLast(), visited < 4000 {
            visited += 1
            if TeamsAccessibility.string(e, kAXRoleAttribute as String) == "AXMenuItem" {
                let value = TeamsAccessibility.attribute(e, kAXValueAttribute as String).map { "\($0)" } ?? "-"
                let selected = TeamsAccessibility.attribute(e, kAXSelectedAttribute as String).map { "\($0)" } ?? "-"
                let mark = TeamsAccessibility.string(e, kAXMenuItemMarkCharAttribute as String) ?? "-"
                items.append("\"\(TeamsAccessibility.string(e, kAXTitleAttribute as String) ?? "?")\" value=\(value) selected=\(selected) mark=\(mark)")
            }
            stack.append(contentsOf: TeamsAccessibility.children(e))
        }
        Log.write("Teams: video options menu: " + (items.isEmpty ? "(no menu items)" : items.joined(separator: ", ")))
    }

    private func findInMeetingWindow(_ id: String) -> AXUIElement? {
        findInMeetingWindow(where: { TeamsAccessibility.string($0, "AXDOMIdentifier") == id })
    }

    /// Finds the first element matching `match` in the meeting window (or all windows if unknown). On queue.
    private func findInMeetingWindow(where match: (AXUIElement) -> Bool) -> AXUIElement? {
        let roots: [AXUIElement]
        if let w = meetingWindow?.element { roots = [w] }
        else if let app = app { roots = TeamsAccessibility.attribute(app, kAXWindowsAttribute as String) as? [AXUIElement] ?? [] }
        else { return nil }
        for root in roots {
            var stack = [root]
            var visited = 0
            while let e = stack.popLast(), visited < 4000 {
                visited += 1
                if match(e) { return e }
                stack.append(contentsOf: TeamsAccessibility.children(e))
            }
        }
        return nil
    }
}
