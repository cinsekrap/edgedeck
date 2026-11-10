import AppKit
import CryptoKit
import Security

/// Updates from GitHub Releases.
///
/// Checks the latest (non-pre-release) release of the public repo, and can install
/// it: download the DMG, check its SHA-256 against the release notes and GitHub's
/// own digest, then check the app inside is signed by the same Developer ID team as
/// this one, with the same bundle ID, notarised, and newer. Only then is the app
/// swapped and relaunched. The signature is what proves the release came from us:
/// a checksum only proves the file arrived as GitHub stored it.
final class Updater {
    static let repo = "cinsekrap/edgedeck"

    struct Release {
        let version: String
        let notes: String
        let pageURL: URL
        let dmgURL: URL?
        let dmgSize: Int
        let githubDigest: String?   // "sha256:…" from the API
        let notesDigest: String?    // a 64-hex SHA-256 found in the release notes
    }

    private(set) var latest: Release?
    private(set) var lastChecked: Date?
    private(set) var lastError: String?
    private(set) var checking = false
    private(set) var installing = false
    /// Called on the main thread whenever the state above changes.
    var onChange: (() -> Void)?

    private var timer: Timer?

    static var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    var updateAvailable: Bool {
        guard let l = latest else { return false }
        return Self.compare(l.version, Self.currentVersion) > 0
    }

    /// Developer ID team of the running app, or nil for an ad-hoc / development build.
    static let ownTeam: String? = {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code = code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let s = staticCode else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(s, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return nil }
        return dict[kSecCodeInfoTeamIdentifier as String] as? String
    }()

    /// Can this copy replace itself? Needs a Developer ID signature to check against,
    /// and a folder it's allowed to write to.
    var canInstall: Bool {
        guard Self.ownTeam != nil else { return false }
        let parent = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
        return FileManager.default.isWritableFile(atPath: parent)
    }

    var state: [String: Any] {
        var s: [String: Any] = ["current": Self.currentVersion, "checking": checking, "installing": installing,
                                "available": updateAvailable, "canInstall": canInstall,
                                "autoCheck": Self.autoCheck]
        if let l = latest { s["latest"] = l.version; s["notes"] = l.notes; s["page"] = l.pageURL.absoluteString }
        if let d = lastChecked { s["checked"] = d.timeIntervalSince1970 * 1000 }
        if let e = lastError { s["error"] = e }
        return s
    }

    static var autoCheck: Bool {
        (ConfigStore.shared.dictionary["updates"] as? [String: Any])?["autoCheck"] as? Bool ?? true
    }

    /// Checks a minute after launch, then once a day, while automatic checks are on.
    func start() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            if Self.autoCheck { self?.check() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 24 * 3600, repeats: true) { [weak self] _ in
            if Self.autoCheck { self?.check() }
        }
    }

    // MARK: Checking

    func check(_ done: (() -> Void)? = nil) {
        guard !checking else { done?(); return }
        checking = true
        lastError = nil
        onChange?()
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(Self.repo)/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("EdgeDeck/\(Self.currentVersion)", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 20
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            var release: Release?
            var problem: String?
            if let error = error {
                problem = error.localizedDescription
            } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                problem = http.statusCode == 404 ? "No releases published yet" : "GitHub replied \(http.statusCode)"
            } else if let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                release = Self.parse(json)
                if release == nil { problem = "Couldn't read the latest release" }
            } else {
                problem = "Couldn't read the latest release"
            }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.checking = false
                self.lastChecked = Date()
                if let r = release {
                    let wasKnown = self.latest?.version == r.version
                    self.latest = r
                    if self.updateAvailable && !wasKnown { Log.write("Updates: \(r.version) is available (running \(Self.currentVersion))") }
                }
                if let p = problem { self.lastError = p; Log.write("Updates: check failed: \(p)") }
                self.onChange?()
                done?()
            }
        }.resume()
    }

    private static func parse(_ json: [String: Any]) -> Release? {
        guard let tag = json["tag_name"] as? String,
              let page = (json["html_url"] as? String).flatMap(URL.init(string:)) else { return nil }
        if json["prerelease"] as? Bool == true || json["draft"] as? Bool == true { return nil }
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        let notes = json["body"] as? String ?? ""
        let assets = json["assets"] as? [[String: Any]] ?? []
        let dmg = assets.first { ($0["name"] as? String)?.lowercased().hasSuffix(".dmg") == true }
        let notesDigest = notes.range(of: "\\b[0-9a-fA-F]{64}\\b", options: .regularExpression).map { notes[$0].lowercased() }
        return Release(version: version, notes: notes, pageURL: page,
                       dmgURL: (dmg?["browser_download_url"] as? String).flatMap(URL.init(string:)),
                       dmgSize: dmg?["size"] as? Int ?? 0,
                       githubDigest: (dmg?["digest"] as? String)?.lowercased(),
                       notesDigest: notesDigest)
    }

    /// Compares dotted versions numerically: 0.10.0 > 0.9.2.
    static func compare(_ a: String, _ b: String) -> Int {
        let pa = a.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x < y ? -1 : 1 }
        }
        return 0
    }

    // MARK: Installing

    /// Downloads, verifies and installs the latest release, then relaunches.
    /// Calls back with an error message if anything fails (nothing is changed then).
    func install(_ done: @escaping (String?) -> Void) {
        guard !installing else { done("Already installing"); return }
        guard let release = latest, updateAvailable, let dmgURL = release.dmgURL else { done("No update to install"); return }
        guard let team = Self.ownTeam else { done("This copy isn't signed with a Developer ID, so it can't check an update. Download it from the release page instead."); return }
        guard canInstall else { done("EdgeDeck can't replace itself in its folder. Download the update from the release page instead."); return }
        installing = true
        onChange?()
        Log.write("Updates: installing \(release.version)")

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let error = Self.downloadAndInstall(release: release, dmgURL: dmgURL, team: team)
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let e = error {
                    self.installing = false
                    Log.write("Updates: \(release.version) not installed: \(e)")
                    self.onChange?()
                    done(e)
                } else {
                    Log.write("Updates: installed \(release.version); relaunching")
                    done(nil)
                    Self.relaunch()
                }
            }
        }
    }

    /// Runs off the main thread. Returns nil on success (the new app is in place).
    private static func downloadAndInstall(release: Release, dmgURL: URL, team: String) -> String? {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("EdgeDeck-update-\(UUID().uuidString)")
        try? fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }

        // 1. Download.
        let dmg = work.appendingPathComponent("EdgeDeck.dmg")
        var downloadError: String?
        let sem = DispatchSemaphore(value: 0)
        var request = URLRequest(url: dmgURL)
        request.setValue("EdgeDeck/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 120
        URLSession.shared.downloadTask(with: request) { tmp, response, error in
            if let error = error { downloadError = error.localizedDescription }
            else if let http = response as? HTTPURLResponse, http.statusCode != 200 { downloadError = "Download failed (\(http.statusCode))" }
            else if let tmp = tmp { do { try fm.moveItem(at: tmp, to: dmg) } catch { downloadError = error.localizedDescription } }
            sem.signal()
        }.resume()
        sem.wait()
        if let e = downloadError { return e }

        // 2. Checksums: must match every SHA-256 we were given, and we need at least one.
        guard let data = try? Data(contentsOf: dmg) else { return "Couldn't read the download" }
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let expected = [release.notesDigest, release.githubDigest.map { $0.replacingOccurrences(of: "sha256:", with: "") }].compactMap { $0 }
        if expected.isEmpty { return "The release doesn't list a SHA-256 to check the download against" }
        if expected.contains(where: { $0 != sha }) { return "The download's SHA-256 doesn't match the release (\(sha.prefix(12))…)" }
        Log.write("Updates: download matches the published SHA-256 (\(sha.prefix(12))…)")

        // 3. Mount it (read-only, hidden from Finder).
        let mount = work.appendingPathComponent("mnt")
        try? fm.createDirectory(at: mount, withIntermediateDirectories: true)
        guard shell("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path]).status == 0 else {
            return "Couldn't open the downloaded disk image"
        }
        defer { _ = shell("/usr/bin/hdiutil", ["detach", mount.path, "-force"]) }
        let mountedApp = mount.appendingPathComponent("EdgeDeck.app")
        guard fm.fileExists(atPath: mountedApp.path) else { return "The disk image doesn't contain EdgeDeck.app" }

        // 4. Copy it next to the installed app, then verify the copy (what we'll actually run).
        let installed = URL(fileURLWithPath: Bundle.main.bundlePath)
        let staged = installed.deletingLastPathComponent().appendingPathComponent(".EdgeDeck-update.app")
        try? fm.removeItem(at: staged)
        guard shell("/usr/bin/ditto", [mountedApp.path, staged.path]).status == 0 else { return "Couldn't copy the new version" }
        if let problem = verify(app: staged, team: team, newerThan: currentVersion) {
            try? fm.removeItem(at: staged)
            return problem
        }

        // 5. Swap it in. The running copy keeps working until we relaunch.
        do {
            _ = try fm.replaceItemAt(installed, withItemAt: staged)
        } catch {
            try? fm.removeItem(at: staged)
            return "Couldn't replace the app: \(error.localizedDescription)"
        }
        return nil
    }

    /// Checks a downloaded app before it's allowed to replace this one.
    static func verify(app: URL, team: String, newerThan current: String) -> String? {
        let bundleID = Bundle.main.bundleIdentifier ?? "com.nicparkes.edgedeck"
        // Signed with a Developer ID Application certificate from our team, as our bundle ID.
        let requirementText = """
        anchor apple generic and identifier "\(bundleID)" \
        and certificate 1[field.1.2.840.113635.100.6.2.6] exists \
        and certificate leaf[field.1.2.840.113635.100.6.1.13] exists \
        and certificate leaf[subject.OU] = "\(team)"
        """
        var code: SecStaticCode?
        var requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code = code,
              SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess else {
            return "Couldn't read the new version's signature"
        }
        var cfError: Unmanaged<CFError>?
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        let status = SecStaticCodeCheckValidityWithErrors(code, flags, requirement, &cfError)
        if status != errSecSuccess {
            let detail = cfError.map { CFErrorCopyDescription($0.takeRetainedValue()) as String } ?? "error \(status)"
            return "The new version isn't signed by the same developer (\(detail))"
        }
        // Notarised by Apple (Gatekeeper's own check).
        let gate = shell("/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", app.path])
        guard gate.status == 0, gate.output.contains("Notarized Developer ID") else {
            return "The new version isn't notarised by Apple"
        }
        // Newer than what's running (no downgrades).
        let version = Bundle(url: app)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        guard compare(version, current) > 0 else { return "The download is version \(version), not newer than \(current)" }
        Log.write("Updates: \(version) verified: Developer ID team \(team), notarised")
        return nil
    }

    private static func shell(_ path: String, _ args: [String]) -> (status: Int32, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, error.localizedDescription) }
        let out = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(data: out, encoding: .utf8) ?? "")
    }

    static func relaunch() {
        let path = Bundle.main.bundlePath.replacingOccurrences(of: "'", with: "'\\''")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; /usr/bin/open '\(path)'"]
        try? p.run()
        NSApp.terminate(nil)
    }
}
