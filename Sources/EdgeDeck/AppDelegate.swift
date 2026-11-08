import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let bridge = Bridge()
    private let touch = TouchReader()
    private let teams = MeetingHub()   // Teams and Zoom
    private var dashboard: DashboardController!
    private var editor: EditorController?
    private var settings: SettingsController?
    private var setup: SetupController?
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    /// The most recent app in front other than EdgeDeck (its windows don't count).
    private var lastFrontApp: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.write("EdgeDeck launched")
        buildMainMenu()

        dashboard = DashboardController(bridge: bridge)
        bridge.touchStatus = { [weak self] in self?.touch.status ?? "" }
        bridge.canvas = { [weak self] in self?.dashboard.canvas ?? .zero }
        bridge.teams = teams
        bridge.omnifocus.edgeFrame = { DashboardController.edgeScreen()?.frame }
        teams.onUpdate = { [weak self] in
            guard let self = self else { return }
            self.bridge.broadcast("window.EdgeTeams && EdgeTeams.update(\(JSON.string(self.teams.state)))")
        }
        if ConfigStore.shared.teamsEnabled { teams.start() }
        bridge.onConfigSaved = { [weak self] in
            guard let self = self else { return }
            if ConfigStore.shared.teamsEnabled { self.teams.start() } else { self.teams.stop() }
            self.touch.reloadSettings()
            self.dashboard.place()
            self.bridge.broadcast("window.EdgeDeck && EdgeDeck.reloadConfig()")
        }
        bridge.onOpenEditor = { [weak self] in self?.openEditor() }
        bridge.onOpenSettings = { [weak self] in self?.openSettings() }
        bridge.onOpenSetup = { [weak self] in self?.openSetup() }
        bridge.onSetupDone = { [weak self] in
            // Setup has dealt with Input Monitoring; make sure touch is running with it.
            self?.touch.start()
            self?.setup?.window.close()
        }
        // Pages can follow the app in front, so tell the dashboard when it changes.
        lastFrontApp = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        bridge.frontApp = { [weak self] in self?.lastFrontApp }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                          object: nil, queue: .main) { [weak self] note in
            guard let self = self,
                  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let id = app.bundleIdentifier, id != Bundle.main.bundleIdentifier else { return }
            self.lastFrontApp = id
            self.bridge.broadcast("window.EdgeDeck && EdgeDeck.frontAppChanged(\(JSON.string(id)))")
        }
        bridge.onCalibrate = { [weak self] reset in self?.dashboard.calibrate(reset: reset) }

        touch.onContacts = { [weak self] contacts in self?.dashboard.send(contacts) }
        // Existing installs (a config already there) count as set up.
        let defaults = UserDefaults.standard
        if ConfigStore.shared.loadRaw() != nil && defaults.object(forKey: "setupDone") == nil {
            defaults.set(true, forKey: "setupDone")
        }
        // Setup explains and asks for Input Monitoring; only ask straight away once that's done.
        if !TouchReader.hasInputMonitoringAccess && defaults.bool(forKey: "setupDone") {
            TouchReader.requestInputMonitoringAccess()
        }
        touch.start()

        dashboard.place()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            // Displays settle over a second or so after a change.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self?.dashboard.place() }
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "rectangle.split.3x1", accessibilityDescription: "EdgeDeck")
        }
        menu.delegate = self
        statusItem.menu = menu

        if !UserDefaults.standard.bool(forKey: "setupDone") {
            // First run (or setup not finished before a restart): show setup.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.openSetup() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        touch.stop()
        teams.stop()
    }

    // MARK: Menus

    private func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(settingsItem)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit EdgeDeck", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let touchLine = NSMenuItem(title: "Touch: \(touch.status)", action: nil, keyEquivalent: "")
        touchLine.isEnabled = false
        menu.addItem(touchLine)
        let screenLine = NSMenuItem(title: dashboard.screenFound ? "Display: Xeneon Edge found" : "Display: Xeneon Edge not found",
                                    action: nil, keyEquivalent: "")
        screenLine.isEnabled = false
        menu.addItem(screenLine)
        menu.addItem(.separator())

        let show = NSMenuItem(title: "Show Dashboard on Edge", action: #selector(toggleDashboard), keyEquivalent: "")
        show.state = dashboard.enabled ? .on : .off
        show.target = self
        menu.addItem(show)
        add("Edit Dashboard…", #selector(openEditor), key: "e")
        let profiles = ConfigStore.shared.dictionary["profiles"] as? [[String: Any]] ?? []
        if profiles.count > 1 {
            let active = ConfigStore.shared.dictionary["activeProfile"] as? String
            let sub = NSMenu()
            for p in profiles {
                guard let id = p["id"] as? String else { continue }
                let item = NSMenuItem(title: p["name"] as? String ?? "Profile", action: #selector(switchProfile(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = id
                item.state = id == active ? .on : .off
                sub.addItem(item)
            }
            let profileItem = NSMenuItem(title: "Profile", action: nil, keyEquivalent: "")
            profileItem.submenu = sub
            menu.addItem(profileItem)
        }
        add("Settings…", #selector(openSettings), key: ",")
        add("Set Up EdgeDeck…", #selector(openSetup))
        add("Reload Dashboard", #selector(reloadDashboard), key: "r")
        add("Blank Edge Now", #selector(blankNow), key: "b")
        menu.addItem(.separator())

        let perms = NSMenu()
        let im = NSMenuItem(title: "Input Monitoring (for touch)\(TouchReader.hasInputMonitoringAccess ? " ✓" : "")",
                            action: #selector(openInputMonitoring), keyEquivalent: "")
        im.target = self
        perms.addItem(im)
        let ax = NSMenuItem(title: "Accessibility (for keyboard shortcuts)\(Actions.hasAccessibility ? " ✓" : "")",
                            action: #selector(openAccessibility), keyEquivalent: "")
        ax.target = self
        perms.addItem(ax)
        let permItem = NSMenuItem(title: "Permissions", action: nil, keyEquivalent: "")
        permItem.submenu = perms
        menu.addItem(permItem)

        // Diagnostics only appears while ⌥ Option is held as the menu opens (calibration and the
        // config file are also in Settings). The inspectors are kept for when Teams or Zoom
        // change their controls, or a panel's touch needs diagnosing.
        if NSEvent.modifierFlags.contains(.option) {
            let diag = NSMenu()
            let item = { (title: String, action: Selector) in
                let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
                i.target = self
                diag.addItem(i)
            }
            item("Calibrate Touch…", #selector(calibrateTouch))
            item("Reconnect Touch Controller", #selector(restartTouch))
            item("Open Log", #selector(openLog))
            item("Show Config File", #selector(showConfig))
            diag.addItem(.separator())
            item("Record Next 300 Touch Reports", #selector(recordTouches))
            item("Inspect Teams Controls", #selector(inspectTeams))
            item("Inspect Zoom Menus", #selector(inspectZoom))
            let diagItem = NSMenuItem(title: "Diagnostics", action: nil, keyEquivalent: "")
            diagItem.submenu = diag
            menu.addItem(diagItem)
        }

        if #available(macOS 13.0, *) {
            let login = NSMenuItem(title: "Start at Login", action: #selector(toggleLogin), keyEquivalent: "")
            login.state = SMAppService.mainApp.status == .enabled ? .on : .off
            login.target = self
            menu.addItem(login)
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit EdgeDeck", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    private func add(_ title: String, _ action: Selector, key: String = "") {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
    }

    // MARK: Actions

    @objc private func toggleDashboard() {
        dashboard.enabled.toggle()
        dashboard.place()
    }

    @objc func openEditor() {
        if editor == nil { editor = EditorController(bridge: bridge) }
        editor?.show()
    }

    @objc private func switchProfile(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        try? ConfigStore.shared.update(section: "activeProfile", json: JSON.string(id))
        bridge.onConfigSaved?()
    }

    @objc func openSetup() {
        if setup == nil {
            setup = SetupController(bridge: bridge)
            setup?.onClose = { [weak self] in
                // Closing setup part-way clears the "setting up" screen on the Edge.
                self?.bridge.broadcast("window.EdgeDeck && EdgeDeck.setupProgress(null)")
                self?.setup = nil
            }
        }
        setup?.show()
    }

    @objc func openSettings() {
        if settings == nil { settings = SettingsController(bridge: bridge) }
        settings?.show()
    }

    @objc private func reloadDashboard() {
        dashboard.reload()
        dashboard.place()
    }

    @objc private func inspectZoom() {
        ZoomAccessibility.dumpToLog()
    }

    @objc private func inspectTeams() {
        TeamsAccessibility.dumpToLog()
    }

    @objc private func blankNow() {
        dashboard.webView.evaluateJavaScript("window.EdgeDeck && EdgeDeck.blankNow()", completionHandler: nil)
    }

    @objc private func openInputMonitoring() {
        TouchReader.requestInputMonitoringAccess()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!)
    }

    @objc private func openAccessibility() {
        Actions.promptForAccessibility()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    @objc private func calibrateTouch() {
        if let error = dashboard.calibrate() {
            let alert = NSAlert()
            alert.messageText = "Can't calibrate"
            alert.informativeText = error
            alert.runModal()
        }
    }

    @objc private func recordTouches() {
        touch.rawLogBudget = 300
        Log.write("--- Recording next 300 touch reports. Touch the screen now. ---")
    }

    @objc private func restartTouch() {
        touch.start()
    }

    @objc private func openLog() {
        NSWorkspace.shared.open(Log.url)
    }

    @objc private func showConfig() {
        let file = ConfigStore.shared.file
        if FileManager.default.fileExists(atPath: file.path) {
            NSWorkspace.shared.activateFileViewerSelecting([file])
        } else {
            NSWorkspace.shared.open(ConfigStore.shared.directory)
        }
    }

    @objc private func toggleLogin() {
        guard #available(macOS 13.0, *) else { return }
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            Log.write("Login item change failed: \(error.localizedDescription)")
            let alert = NSAlert()
            alert.messageText = "Couldn't change Start at Login"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }
}
