import AppKit

/// Now Playing and media controls for Spotify and Apple Music via AppleScript,
/// with system media keys as a fallback for anything else (browsers etc.).
final class Media {
    private let spotifyID = "com.spotify.client"
    private let musicID = "com.apple.Music"
    private var artworkCache: (key: String, dataURL: String)?
    private var lastActiveApp: String?

    private func isRunning(_ bundleID: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }

    @discardableResult
    private func run(_ source: String) -> NSAppleEventDescriptor? {
        var error: NSDictionary?
        let script = NSAppleScript(source: source)
        let result = script?.executeAndReturnError(&error)
        if let error = error {
            Log.write("AppleScript error: \(error[NSAppleScript.errorMessage] ?? error)")
        }
        return result
    }

    private static let sep = "character id 30"

    private func spotifyState() -> [String: Any]? {
        guard isRunning(spotifyID) else { return nil }
        let src = """
        tell application id "\(spotifyID)"
            set d to \(Self.sep)
            set s to player state as string
            if s is "stopped" then return s
            set t to current track
            return s & d & (name of t) & d & (artist of t) & d & (album of t) & d & (artwork url of t) & d & (player position as string) & d & ((duration of t) / 1000 as string)
        end tell
        """
        guard let out = run(src)?.stringValue else { return nil }
        return parse(out, app: "Spotify")
    }

    private func musicState() -> [String: Any]? {
        guard isRunning(musicID) else { return nil }
        let src = """
        tell application id "\(musicID)"
            set d to \(Self.sep)
            set s to player state as string
            if s is "stopped" then return s
            set t to current track
            return s & d & (name of t) & d & (artist of t) & d & (album of t) & d & "" & d & (player position as string) & d & (duration of t as string)
        end tell
        """
        guard let out = run(src)?.stringValue else { return nil }
        var state = parse(out, app: "Music")
        if let title = state["title"] as? String {
            let key = "\(title)|\(state["artist"] ?? "")|\(state["album"] ?? "")"
            if artworkCache?.key != key {
                let art = run("""
                tell application id "\(musicID)"
                    try
                        return raw data of artwork 1 of current track
                    end try
                end tell
                """)
                if let data = art?.data, !data.isEmpty {
                    let mime = data.starts(with: [0x89, 0x50]) ? "image/png" : "image/jpeg"
                    artworkCache = (key, "data:\(mime);base64,\(data.base64EncodedString())")
                } else {
                    artworkCache = (key, "")
                }
            }
            state["artwork"] = artworkCache?.dataURL ?? ""
        }
        return state
    }

    private func parse(_ out: String, app: String) -> [String: Any] {
        let parts = out.components(separatedBy: "\u{1E}")
        var state: [String: Any] = ["app": app, "state": parts.first ?? "stopped"]
        guard parts.count >= 7 else { return state }
        func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: ".")) ?? 0 }
        state["title"] = parts[1]
        state["artist"] = parts[2]
        state["album"] = parts[3]
        state["artwork"] = parts[4]
        state["position"] = num(parts[5])
        state["duration"] = num(parts[6])
        return state
    }

    func state() -> [String: Any] {
        let candidates = [spotifyState(), musicState()].compactMap { $0 }
        let chosen = candidates.first { ($0["state"] as? String) == "playing" }
            ?? candidates.first { ($0["state"] as? String) == "paused" && ($0["app"] as? String) == lastActiveApp }
            ?? candidates.first { ($0["state"] as? String) == "paused" }
            ?? candidates.first
        var result = chosen ?? ["app": "", "state": "stopped"]
        if let app = result["app"] as? String, !app.isEmpty, (result["state"] as? String) == "playing" {
            lastActiveApp = app
        }
        result["volume"] = volume()
        return result
    }

    /// The app to send commands to: the last one seen playing if it's still
    /// open, otherwise whichever of Spotify / Music is running.
    private func targetApp() -> String? {
        if let last = lastActiveApp, isRunning(last == "Spotify" ? spotifyID : musicID) {
            return last
        } else if isRunning(spotifyID) {
            return "Spotify"
        } else if isRunning(musicID) {
            return "Music"
        }
        return nil
    }

    func control(_ action: String) {
        guard let target = targetApp() else {
            // Nothing scriptable is open: send a system media key instead.
            switch action {
            case "playpause": Self.postMediaKey(16)
            case "next": Self.postMediaKey(17)
            case "previous": Self.postMediaKey(18)
            default: break
            }
            return
        }
        let id = target == "Spotify" ? spotifyID : musicID
        let command: String
        switch action {
        case "playpause": command = "playpause"
        case "next": command = "next track"
        case "previous": command = "previous track"
        default: return
        }
        run("tell application id \"\(id)\" to \(command)")
    }

    func seek(_ seconds: Double) {
        guard let target = targetApp() else { return }
        let id = target == "Spotify" ? spotifyID : musicID
        run("tell application id \"\(id)\" to set player position to \(String(format: "%.1f", seconds))")
    }

    func volume() -> Int {
        Int(run("output volume of (get volume settings)")?.int32Value ?? 0)
    }

    func setVolume(_ value: Int) {
        run("set volume output volume \(max(0, min(100, value)))")
    }

    func toggleMute() {
        run("set volume output muted (not (output muted of (get volume settings)))")
    }

    /// NX_KEYTYPE_PLAY = 16, NEXT = 17, PREVIOUS = 18. Needs Accessibility permission.
    static func postMediaKey(_ key: Int32) {
        func post(down: Bool) {
            let flags = NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00)
            let data1 = Int((key << 16) | ((down ? 0xA : 0xB) << 8))
            let event = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags,
                                           timestamp: 0, windowNumber: 0, context: nil,
                                           subtype: 8, data1: data1, data2: -1)
            event?.cgEvent?.post(tap: .cghidEventTap)
        }
        post(down: true)
        post(down: false)
    }
}
