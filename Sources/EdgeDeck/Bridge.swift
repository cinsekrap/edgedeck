import AppKit
import WebKit
import ServiceManagement

/// Message bridge between the web dashboard and the Mac.
/// JS sends {id, cmd, args} to window.webkit.messageHandlers.edge;
/// Swift answers by calling EdgeBridge._reply(id, error, value).
final class Bridge: NSObject, WKScriptMessageHandler {
    let media = Media()
    var onConfigSaved: (() -> Void)?
    var onOpenEditor: (() -> Void)?
    var onOpenSettings: (() -> Void)?
    var onOpenSetup: (() -> Void)?
    var onSetupDone: (() -> Void)?
    var frontApp: () -> String? = { nil }
    var onCalibrate: ((_ reset: Bool) -> String?)?
    var touchStatus: () -> String = { "" }
    var canvas: () -> CGSize = { .zero }
    var teams: MeetingHub?
    let omnifocus = OmniFocusService()
    let elgato = ElgatoLights()
    let updater = Updater()

    private let views = NSHashTable<WKWebView>.weakObjects()

    func register(_ webView: WKWebView) { views.add(webView) }

    func broadcast(_ js: String) {
        for view in views.allObjects {
            view.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        // Only EdgeDeck's own pages (top frame, bundled files) may use the bridge.
        guard message.frameInfo.isMainFrame, WebViewFactory.isOwnPage(message.frameInfo.request.url) else {
            Log.write("Ignored a bridge message from \(message.frameInfo.request.url?.absoluteString.prefix(80) ?? "an unknown page")")
            return
        }
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        let id = (body["id"] as? NSNumber)?.intValue ?? 0
        let args = body["args"] as? [String: Any] ?? [:]
        weak var webView = message.webView

        func reply(_ value: Any?, error: String? = nil) {
            guard id != 0, let view = webView else { return }
            let js = "window.EdgeBridge && EdgeBridge._reply(\(id), \(JSON.string(error)), \(JSON.string(value)))"
            view.evaluateJavaScript(js, completionHandler: nil)
        }

        func background(_ work: @escaping () -> Any?) {
            DispatchQueue.global(qos: .userInitiated).async {
                let value = work()
                DispatchQueue.main.async { reply(value) }
            }
        }

        func backgroundResult(_ work: @escaping () -> (Any?, String?)) {
            DispatchQueue.global(qos: .userInitiated).async {
                let (value, error) = work()
                DispatchQueue.main.async { reply(value, error: error) }
            }
        }

        switch cmd {
        case "touch.calibrate":
            if let error = onCalibrate?(args["reset"] as? Bool ?? false) {
                reply(nil, error: error)
            } else {
                reply(true)
            }

        case "teams.state":
            reply(teams?.state ?? ["connected": false, "paired": false, "meeting": [String: Any]()])

        case "teams.action":
            guard let teams = teams else { reply(nil, error: "Teams integration is off"); return }
            if let error = teams.send(action: args["action"] as? String ?? "", type: args["type"] as? String) {
                reply(nil, error: error)
            } else {
                reply(true)
            }

        case "omnifocus.perspectives":
            omnifocus.perspectives { value, error in reply(value, error: error) }

        case "omnifocus.view":
            omnifocus.view(perspective: args["perspective"] as? String ?? "") { value, error in reply(value, error: error) }

        case "omnifocus.complete":
            omnifocus.complete(taskID: args["id"] as? String ?? "") { value, error in reply(value, error: error) }

        case "omnifocus.plan":
            omnifocus.plan(taskID: args["id"] as? String ?? "", date: (args["date"] as? NSNumber)?.doubleValue) { value, error in
                reply(value, error: error)
            }

        case "omnifocus.launch":
            omnifocus.launch()
            reply(true)

        case "config.update":
            guard let section = args["section"] as? String, !section.isEmpty, let json = args["json"] as? String else {
                reply(nil, error: "Missing section"); return
            }
            do {
                try ConfigStore.shared.update(section: section, json: json)
                reply(true)
                onConfigSaved?()
            } catch {
                reply(nil, error: error.localizedDescription)
            }

        case "file.save":
            // Asks where to save, then writes the JSON there. Replies with the path, or null if cancelled.
            let name = args["name"] as? String ?? "EdgeDeck.json"
            let json = args["json"] as? String ?? ""
            NSApp.activate(ignoringOtherApps: true)
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            panel.canCreateDirectories = true
            panel.begin { result in
                guard result == .OK, let url = panel.url else { reply(nil); return }
                do {
                    try json.data(using: .utf8)?.write(to: url, options: .atomic)
                    reply(url.path)
                } catch {
                    reply(nil, error: error.localizedDescription)
                }
            }

        case "file.open":
            // Asks for a profile or backup file and replies with its text (null if cancelled).
            NSApp.activate(ignoringOtherApps: true)
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = false
            panel.canChooseDirectories = false
            panel.message = (args["kind"] as? String) == "restore" ? "Choose an EdgeDeck backup" : "Choose an EdgeDeck profile"
            panel.begin { result in
                guard result == .OK, let url = panel.url else { reply(nil); return }
                guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size < 20_000_000,
                      let text = try? String(contentsOf: url, encoding: .utf8) else {
                    reply(nil, error: "Couldn't read that file"); return
                }
                reply(text)
            }

        case "updates.state":
            reply(updater.state)

        case "updates.check":
            updater.check { [weak self] in reply(self?.updater.state) }

        case "updates.install":
            updater.install { error in reply(error == nil, error: error) }

        case "updates.page":
            if let url = updater.latest?.pageURL ?? URL(string: "https://github.com/\(Updater.repo)/releases") {
                NSWorkspace.shared.open(url)
            }
            reply(true)

        case "app.front":
            reply(frontApp())

        case "setup.state":
            // Which step setup was on (so it can resume after a restart), and whether it's finished.
            let d = UserDefaults.standard
            if let step = (args["step"] as? NSNumber)?.intValue { d.set(step, forKey: "setupStep") }
            reply(["step": d.integer(forKey: "setupStep"), "done": d.bool(forKey: "setupDone")])

        case "setup.done":
            UserDefaults.standard.set(true, forKey: "setupDone")
            UserDefaults.standard.set(0, forKey: "setupStep")
            broadcast("window.EdgeDeck && EdgeDeck.setupProgress(null)")
            onSetupDone?()
            reply(true)

        case "setup.progress":
            // Mirror the setup window's step on the Edge ("Setting up EdgeDeck… step 3 of 7").
            broadcast("window.EdgeDeck && EdgeDeck.setupProgress(\(JSON.string(args["progress"])))")
            reply(true)

        case "setup.open":
            onOpenSetup?()
            reply(true)

        case "apps.installed":
            // Which of these bundle IDs are installed (to pre-tick integrations).
            let ids = args["ids"] as? [String] ?? []
            reply(ids.filter { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) != nil })

        case "app.relaunch":
            // Quit and reopen EdgeDeck (Input Monitoring only takes effect for a fresh launch).
            reply(true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                let path = Bundle.main.bundlePath.replacingOccurrences(of: "'", with: "'\\''")
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/sh")
                p.arguments = ["-c", "sleep 1; /usr/bin/open '\(path)'"]
                try? p.run()
                NSApp.terminate(nil)
            }

        case "settings.open":
            onOpenSettings?()
            reply(true)

        case "config.reveal":
            let file = ConfigStore.shared.file
            if FileManager.default.fileExists(atPath: file.path) {
                NSWorkspace.shared.activateFileViewerSelecting([file])
            } else {
                NSWorkspace.shared.open(ConfigStore.shared.directory)
            }
            reply(true)

        case "login.get":
            if #available(macOS 13.0, *) {
                reply(["supported": true, "enabled": SMAppService.mainApp.status == .enabled])
            } else {
                reply(["supported": false, "enabled": false])
            }

        case "login.set":
            guard #available(macOS 13.0, *) else { reply(nil, error: "Needs macOS 13 or later"); return }
            do {
                if args["enabled"] as? Bool ?? false { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                reply(SMAppService.mainApp.status == .enabled)
            } catch {
                reply(nil, error: error.localizedDescription)
            }

        case "permissions.open":
            // Opens the relevant pane of System Settings → Privacy & Security.
            let panes = ["inputMonitoring": "Privacy_ListenEvent", "accessibility": "Privacy_Accessibility",
                         "calendars": "Privacy_Calendars", "automation": "Privacy_Automation"]
            let which = args["which"] as? String ?? ""
            if which == "inputMonitoring" { TouchReader.requestInputMonitoringAccess() }
            if which == "accessibility" { Actions.promptForAccessibility() }
            if let pane = panes[which], let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
                NSWorkspace.shared.open(url)
            }
            reply(true)

        case "elgato.list":
            elgato.list { reply($0) }

        case "elgato.set":
            let ids = args["ids"] as? [String] ?? []
            elgato.set(ids: ids, on: args["on"] as? Bool, brightness: (args["brightness"] as? NSNumber)?.intValue,
                       temperature: (args["temperature"] as? NSNumber)?.intValue) { count in
                if count == 0 { reply(nil, error: "Couldn't reach the lights") } else { reply(count) }
            }

        case "badges.list":
            background { DockBadges.list() }

        case "display.canvas":
            let c = canvas()
            reply(["width": Int(c.width), "height": Int(c.height)])

        case "system.stats":
            background { SystemStats.shared.snapshot() }

        case "audio.state":
            reply(Audio.state())

        case "audio.setOutput", "audio.setInput":
            let id = (args["id"] as? NSNumber)?.intValue ?? 0
            if Audio.setDefault(id, input: cmd == "audio.setInput") {
                reply(Audio.state())
            } else {
                reply(nil, error: "Couldn't switch to that device")
            }

        case "audio.micMute":
            // {mute: true/false}, or toggle when omitted.
            let current = Audio.micMuted() ?? false
            let wanted = (args["mute"] as? Bool) ?? !current
            if let now = Audio.setMicMuted(wanted) {
                reply(["micMuted": now])
            } else {
                reply(nil, error: "This microphone has no mute or volume control")
            }

        case "calendar.events":
            CalendarSource.shared.events(
                days: (args["days"] as? NSNumber)?.intValue ?? 2,
                limit: (args["limit"] as? NSNumber)?.intValue ?? 6,
                calendars: (args["calendars"] as? String ?? "").components(separatedBy: ","),
                includeAllDay: args["allDay"] as? Bool ?? true
            ) { events, error in
                reply(events, error: error)
            }

        case "script.run":
            let source = args["source"] as? String ?? ""
            let language = args["language"] as? String ?? "applescript"
            guard !source.isEmpty else { reply(nil, error: "Empty script"); return }
            backgroundResult {
                let r = Scripts.run(source: source, language: language)
                return (r.value, r.error)
            }

        case "config.get":
            var payload: [String: Any] = ["config": NSNull()]
            if let raw = ConfigStore.shared.loadForPage() { payload["config"] = raw }
            reply(payload)

        case "config.save":
            guard let json = args["config"] as? String else { reply(nil, error: "Missing config"); return }
            do {
                try ConfigStore.shared.save(json)
                reply(true)
                onConfigSaved?()
            } catch {
                reply(nil, error: error.localizedDescription)
            }

        case "media.state":
            reply(media.state())

        case "media.control":
            media.control(args["action"] as? String ?? "")
            reply(true)

        case "media.seek":
            media.seek((args["position"] as? NSNumber)?.doubleValue ?? 0)
            reply(true)

        case "volume.set":
            media.setVolume((args["value"] as? NSNumber)?.intValue ?? 0)
            reply(true)

        case "volume.mute":
            media.toggleMute()
            reply(true)

        case "action.run":
            if let error = Actions.run(args) {
                Log.write("Action failed: \(error)")
                reply(nil, error: error)
            } else {
                reply(true)
            }

        case "app.icon":
            reply(Actions.iconDataURL(for: args["target"] as? String ?? ""))

        case "apps.list":
            background { Actions.installedApps() }

        case "shortcuts.list":
            background { Actions.shortcutNames() }

        case "status":
            reply([
                "touch": touchStatus(),
                "inputMonitoring": TouchReader.hasInputMonitoringAccess,
                "accessibility": Actions.hasAccessibility,
                "calendar": CalendarSource.shared.status,
                "screenFound": DashboardController.edgeScreen() != nil,
                "configPath": ConfigStore.shared.file.path,
            ] as [String: Any])

        case "permissions.accessibility":
            Actions.promptForAccessibility()
            reply(true)

        case "editor.open":
            onOpenEditor?()
            reply(true)

        case "log":
            Log.write("JS: \(args["message"] as? String ?? "")")
            reply(true)

        default:
            reply(nil, error: "Unknown command \(cmd)")
        }
    }
}
