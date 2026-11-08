import Foundation
import Security

/// Simple append-only log at ~/Library/Logs/EdgeDeck.log
enum Log {
    static let url: URL = {
        let dir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("EdgeDeck.log")
    }()

    private static let queue = DispatchQueue(label: "edgedeck.log")
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    static func write(_ message: String) {
        let line = "\(formatter.string(from: Date()))  \(message)\n"
        queue.async {
            // Keep the log from growing without limit.
            if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
               let size = attrs[.size] as? Int, size > 5_000_000 {
                try? FileManager.default.removeItem(at: url)
            }
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(line.data(using: .utf8)!)
                try? handle.close()
            } else {
                try? line.data(using: .utf8)!.write(to: url)
            }
        }
        #if DEBUG
        print(line, terminator: "")
        #endif
    }
}

/// Small wrapper for EdgeDeck's secrets in the login Keychain.
enum Keychain {
    private static let service = "EdgeDeck"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func read(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func write(_ account: String, _ value: String) -> Bool {
        let data = Data(value.utf8)
        if read(account) == value { return true }
        let status = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return true }
        var add = query(account)
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "EdgeDeck Home Assistant token"
        let added = SecItemAdd(add as CFDictionary, nil)
        if added != errSecSuccess { Log.write("Keychain: couldn't save \(account) (\(added))") }
        return added == errSecSuccess
    }

    static func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}

/// Stores the dashboard configuration as JSON in
/// ~/Library/Application Support/EdgeDeck/config.json.
/// The layout itself is owned by the web side; Swift only reads the few
/// settings it needs (touch orientation, which screen, device IDs).
final class ConfigStore {
    static let shared = ConfigStore()

    let directory: URL
    let file: URL

    private init() {
        directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("EdgeDeck", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        file = directory.appendingPathComponent("config.json")
    }

    func loadRaw() -> String? {
        try? String(contentsOf: file, encoding: .utf8)
    }

    /// The config as the web pages see it: config.json plus the Home Assistant
    /// token from the Keychain (it's never stored in the file).
    func loadForPage() -> String? {
        guard let raw = loadRaw() else { return nil }
        if Self.hasTokenInFile(raw), (try? save(raw)) != nil {
            // Moved an old plain-text token into the Keychain; the automatic backup
            // still has it, so replace that with the cleaned file too.
            let backup = directory.appendingPathComponent("config.backup.json")
            try? FileManager.default.removeItem(at: backup)
            try? FileManager.default.copyItem(at: file, to: backup)
            Log.write("Config: Home Assistant token now kept in the Keychain, not config.json")
        }
        guard let token = Keychain.read(Self.tokenAccount), !token.isEmpty,
              let fresh = loadRaw(), let data = fresh.data(using: .utf8),
              var obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return loadRaw() }
        var ha = obj["homeAssistant"] as? [String: Any] ?? [:]
        ha["token"] = token
        obj["homeAssistant"] = ha
        guard let out = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else { return fresh }
        return String(data: out, encoding: .utf8)
    }

    private static let tokenAccount = "homeAssistant.token"

    private static func hasTokenInFile(_ raw: String) -> Bool {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ha = obj["homeAssistant"] as? [String: Any] else { return false }
        return ha["token"] != nil
    }

    func save(_ json: String) throws {
        guard var data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) else {
            throw NSError(domain: "EdgeDeck", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Config is not valid JSON"])
        }
        // Secrets go to the Keychain, not the file. A missing token key leaves the
        // stored token alone (another section was saved); an empty one removes it.
        if var obj = parsed as? [String: Any], var ha = obj["homeAssistant"] as? [String: Any], let token = ha["token"] {
            let value = (token as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if value.isEmpty { Keychain.delete(Self.tokenAccount) }
            else if !Keychain.write(Self.tokenAccount, value) {
                throw NSError(domain: "EdgeDeck", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "Couldn't save the Home Assistant token to the Keychain"])
            }
            ha["token"] = nil
            obj["homeAssistant"] = ha
            data = try JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        }
        if FileManager.default.fileExists(atPath: file.path) {
            let backup = directory.appendingPathComponent("config.backup.json")
            try? FileManager.default.removeItem(at: backup)
            try? FileManager.default.copyItem(at: file, to: backup)
        }
        try data.write(to: file, options: .atomic)
    }

    /// Replaces one top-level section (e.g. "theme" or "pages") and saves, so the
    /// settings window and the editor each write only what they own.
    func update(section: String, json: String) throws {
        guard let data = json.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            throw NSError(domain: "EdgeDeck", code: 2, userInfo: [NSLocalizedDescriptionKey: "Section is not valid JSON"])
        }
        var config = dictionary
        if config.isEmpty, let defaults = try? JSONSerialization.jsonObject(with: Data("{\"version\":1}".utf8)) as? [String: Any] {
            config = defaults
        }
        if section == "*", let sections = value as? [String: Any] {
            // Several sections at once (one save, one reload).
            for (key, v) in sections { if v is NSNull { config[key] = nil } else { config[key] = v } }
        } else if value is NSNull {
            config[section] = nil
        } else {
            config[section] = value
        }
        let out = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
        try save(String(data: out, encoding: .utf8) ?? "{}")
    }

    var dictionary: [String: Any] {
        guard let raw = loadRaw(), let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    struct DeviceSettings {
        var flipX = false
        var flipY = false
        var swapXY = false
        var screenName = ""
        var fixStretch = true
        var vendorID = 0x27C0
        var productID = 0x0859
    }

    /// Whether to connect to Microsoft Teams (config "teams.enabled", default on).
    var teamsEnabled: Bool {
        (dictionary["teams"] as? [String: Any])?["enabled"] as? Bool ?? true
    }

    var device: DeviceSettings {
        var s = DeviceSettings()
        guard let d = dictionary["device"] as? [String: Any] else { return s }
        s.flipX = d["flipX"] as? Bool ?? false
        s.flipY = d["flipY"] as? Bool ?? false
        s.swapXY = d["swapXY"] as? Bool ?? false
        s.screenName = d["screenName"] as? String ?? ""
        s.fixStretch = d["fixStretch"] as? Bool ?? true
        if let v = Self.parseHex(d["vendorId"]) { s.vendorID = v }
        if let p = Self.parseHex(d["productId"]) { s.productID = p }
        return s
    }

    private static func parseHex(_ any: Any?) -> Int? {
        if let n = any as? Int { return n }
        if let s = any as? String {
            let t = s.lowercased().replacingOccurrences(of: "0x", with: "")
            return Int(t, radix: 16)
        }
        return nil
    }
}

/// JSON helpers for passing values to JavaScript.
enum JSON {
    static func string(_ value: Any?) -> String {
        guard let value = value, !(value is NSNull) else { return "null" }
        if JSONSerialization.isValidJSONObject(value),
           let data = try? JSONSerialization.data(withJSONObject: value),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        // Wrap scalars (strings, numbers, bools) in an array and strip the brackets.
        if let data = try? JSONSerialization.data(withJSONObject: [value]),
           let s = String(data: data, encoding: .utf8) {
            return String(s.dropFirst().dropLast())
        }
        return "null"
    }
}
