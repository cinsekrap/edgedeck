import AppKit
import ApplicationServices

/// Things a dashboard key can do on the Mac.
enum Actions {
    static func run(_ action: [String: Any]) -> String? {
        let type = action["type"] as? String ?? ""
        let target = (action["target"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        switch type {
        case "app":
            return openApp(target)
        case "shortcut":
            return runProcess("/usr/bin/shortcuts", ["run", target])
        case "url":
            guard let url = URL(string: target) else { return "Invalid URL" }
            NSWorkspace.shared.open(url)
            return nil
        case "keys":
            return sendKeys(target)
        case "shell":
            return runProcess("/bin/zsh", ["-lc", target])
        case "applescript", "jxa":
            guard !target.isEmpty else { return "Empty script" }
            DispatchQueue.global(qos: .userInitiated).async {
                let r = Scripts.run(source: target, language: type)
                if let error = r.error { Log.write("Script key failed: \(error)") }
            }
            return nil
        case "media":
            return nil // handled by Bridge
        default:
            return "Unknown action type \(type)"
        }
    }

    static func appURL(for target: String) -> URL? {
        if target.hasPrefix("/") { return URL(fileURLWithPath: target) }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target) { return url }
        // Allow plain names like "Safari"
        for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                    NSHomeDirectory() + "/Applications"] {
            let path = "\(dir)/\(target).app"
            if FileManager.default.fileExists(atPath: path) { return URL(fileURLWithPath: path) }
        }
        return nil
    }

    private static func openApp(_ target: String) -> String? {
        guard let url = appURL(for: target) else { return "App not found: \(target)" }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            if let error = error { Log.write("Open app failed: \(error.localizedDescription)") }
        }
        return nil
    }

    private static func runProcess(_ path: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        let errPipe = Pipe()
        p.standardError = errPipe
        p.terminationHandler = { proc in
            if proc.terminationStatus != 0 {
                let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                Log.write("\(path) \(args.joined(separator: " ")) exited \(proc.terminationStatus): \(err)")
            }
        }
        do { try p.run() } catch { return error.localizedDescription }
        return nil
    }

    // MARK: Keyboard shortcuts

    static var hasAccessibility: Bool { AXIsProcessTrusted() }

    static func promptForAccessibility() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    private static let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
        "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36,
        "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
        "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
        "escape": 53, "esc": 53, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
        "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101, "f11": 103,
        "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113,
        "home": 115, "pageup": 116, "forwarddelete": 117, "f4": 118, "end": 119, "f2": 120,
        "pagedown": 121, "f1": 122, "left": 123, "right": 124, "down": 125, "up": 126,
    ]

    /// Sends a shortcut such as "cmd+shift+4" or "ctrl+alt+f13".
    static func sendKeys(_ combo: String) -> String? {
        guard hasAccessibility else {
            promptForAccessibility()
            return "EdgeDeck needs Accessibility permission to send keystrokes"
        }
        var flags: CGEventFlags = []
        var keyCode: CGKeyCode?
        for raw in combo.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch raw {
            case "cmd", "command", "⌘": flags.insert(.maskCommand)
            case "shift", "⇧": flags.insert(.maskShift)
            case "alt", "opt", "option", "⌥": flags.insert(.maskAlternate)
            case "ctrl", "control", "⌃": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default: keyCode = keyCodes[raw]
            }
        }
        guard let code = keyCode else { return "Unknown key in \(combo)" }
        let source = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        return nil
    }

    // MARK: Lists and icons for the editor

    static func installedApps() -> [[String: String]] {
        var seen = Set<String>()
        var apps: [[String: String]] = []
        let dirs = ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                    NSHomeDirectory() + "/Applications", "/System/Library/CoreServices"]
        for dir in dirs {
            guard let items = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
            for item in items where item.hasSuffix(".app") {
                let url = URL(fileURLWithPath: dir).appendingPathComponent(item)
                guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier, !seen.contains(id) else { continue }
                if dir == "/System/Library/CoreServices" && item != "Finder.app" { continue }
                seen.insert(id)
                apps.append(["name": String(item.dropLast(4)), "id": id])
            }
        }
        return apps.sorted { $0["name"]!.localizedCaseInsensitiveCompare($1["name"]!) == .orderedAscending }
    }

    static func shortcutNames() -> [String] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/shortcuts")
        p.arguments = ["list"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return [] }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (String(data: data, encoding: .utf8) ?? "")
            .split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    private static var iconCache: [String: String] = [:]

    static func iconDataURL(for target: String, size: CGFloat = 160) -> String? {
        if let cached = iconCache[target] { return cached }
        guard let url = appURL(for: target) else { return nil }
        let icon = NSWorkspace.shared.icon(forFile: url.path)
        let pixels = Int(size)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let dataURL = "data:image/png;base64,\(png.base64EncodedString())"
        iconCache[target] = dataURL
        return dataURL
    }
}
