import AppKit
import WebKit

/// Borderless window that never takes keyboard focus, so tapping the
/// dashboard doesn't pull focus away from what you're working in.
final class DashboardWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

enum WebViewFactory {
    static func make(bridge: Bridge, mode: String) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(bridge, name: "edge")
        let modeScript = WKUserScript(source: "window.EDGE_MODE = '\(mode)'; window.EDGE_NATIVE = true;",
                                      injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(modeScript)
        #if DEBUG
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        #else
        // Web Inspector only when asked for: defaults write com.nicparkes.edgedeck WebInspector -bool YES
        if UserDefaults.standard.bool(forKey: "WebInspector") {
            config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        #endif
        config.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = NavigationGuard.shared
        bridge.register(view)
        return view
    }

    static var webRoot: URL {
        #if DEBUG
        if let env = ProcessInfo.processInfo.environment["EDGEDECK_WEB"] {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        #endif
        if let res = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true),
           FileManager.default.fileExists(atPath: res.appendingPathComponent("index.html").path) {
            return res
        }
        #if DEBUG
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("Resources/web", isDirectory: true)
        #else
        // Release builds only ever load the pages inside the signed app bundle.
        return Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/web", isDirectory: true)
        #endif
    }

    /// True for a file inside the bundled web folder: the only pages allowed to
    /// load, and the only ones whose messages the bridge acts on.
    static func isOwnPage(_ url: URL?) -> Bool {
        guard let url = url, url.isFileURL else { return false }
        let root = webRoot.standardizedFileURL.resolvingSymlinksInPath().path
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        return path == root || path.hasPrefix(root.hasSuffix("/") ? root : root + "/")
    }

    static func load(_ view: WKWebView) {
        let root = webRoot
        view.loadFileURL(root.appendingPathComponent("index.html"), allowingReadAccessTo: root)
    }
}

/// Keeps every EdgeDeck web view on its own bundled pages. The pages can ask the
/// Mac to run commands, so nothing else may ever load in them: web links open in
/// the default browser and anything else is refused.
final class NavigationGuard: NSObject, WKNavigationDelegate {
    static let shared = NavigationGuard()

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if WebViewFactory.isOwnPage(url) || url?.absoluteString == "about:blank" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        if let url = url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
           action.targetFrame?.isMainFrame ?? true {
            NSWorkspace.shared.open(url)
        }
        Log.write("Blocked a page load in EdgeDeck's web view: \(url?.scheme ?? "?")://\(url?.host ?? "")")
    }
}

/// The full-screen dashboard shown on the Xeneon Edge.
final class DashboardController {
    let window: DashboardWindow
    let webView: WKWebView
    var enabled = true
    private(set) var screenFound = false
    /// The layout size the page should use, or .zero to use the window as is.
    /// Non-zero when macOS drives the Edge with a 16:9 signal that the panel
    /// stretches to 32:9: the page lays out at the panel's real size and
    /// squashes itself to fit, so the stretch cancels out.
    private(set) var canvas = CGSize.zero

    /// The Xeneon Edge panel's native size.
    static let panelSize = CGSize(width: 2560, height: 720)

    init(bridge: Bridge) {
        webView = WebViewFactory.make(bridge: bridge, mode: "dashboard")
        window = DashboardWindow(contentRect: NSRect(x: 0, y: 0, width: 2560, height: 720),
                                 styleMask: [.borderless], backing: .buffered, defer: false)
        window.backgroundColor = .black
        window.isOpaque = true
        window.hasShadow = false
        // Above the menu bar and Dock, which macOS may draw on this display.
        window.level = .statusBar
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.contentView = webView
        WebViewFactory.load(webView)
    }

    static func edgeScreen() -> NSScreen? {
        let wanted = ConfigStore.shared.device.screenName
        let screens = NSScreen.screens
        if !wanted.isEmpty,
           let s = screens.first(where: { $0.localizedName.localizedCaseInsensitiveContains(wanted) }) {
            return s
        }
        if let s = screens.first(where: { $0.localizedName.localizedCaseInsensitiveContains("XENEON") }) {
            return s
        }
        // Fall back to any very wide (or very tall) display.
        return screens.first { s in
            let f = s.frame
            return f.width / f.height > 3.0 || f.height / f.width > 3.0
        }
    }

    func place() {
        guard enabled, let screen = Self.edgeScreen() else {
            screenFound = Self.edgeScreen() != nil
            window.orderOut(nil)
            return
        }
        screenFound = true
        window.setFrame(screen.frame, display: true)
        window.orderFrontRegardless()
        updateCanvas(for: screen)
    }

    private func updateCanvas(for screen: NSScreen) {
        let f = screen.frame
        let aspect = f.width / f.height
        let isEdge = screen.localizedName.localizedCaseInsensitiveContains("XENEON")
        // Landscape but nowhere near 32:9 (e.g. 16:9 or 4:3): the panel is stretching it.
        let stretched = isEdge && aspect > 1.2 && aspect < 2.5
        let new = stretched && ConfigStore.shared.device.fixStretch ? Self.panelSize : .zero
        guard new != canvas else { return }
        canvas = new
        Log.write(new == .zero ? "Display: using the window size as is (\(Int(f.width))x\(Int(f.height)))"
                               : "Display: Edge is at \(Int(f.width))x\(Int(f.height)); laying out at 2560x720 and squashing to fit")
        webView.evaluateJavaScript("window.EdgeDeck && EdgeDeck.setCanvas(\(Int(new.width)), \(Int(new.height)))", completionHandler: nil)
    }

    func reload() { webView.reload() }

    /// Shows the calibration targets on the Edge (or clears the calibration).
    /// Returns an error message if the dashboard isn't showing.
    func calibrate(reset: Bool = false) -> String? {
        guard window.isVisible else { return "The dashboard isn't showing on the Edge" }
        webView.evaluateJavaScript(reset ? "EdgeDeck.resetCalibration()" : "EdgeDeck.calibrate()", completionHandler: nil)
        return nil
    }

    func send(_ contacts: [TouchContact]) {
        guard window.isVisible else { return }
        let list = contacts.map { String(format: "[%d,%.5f,%.5f]", $0.id, $0.x, $0.y) }.joined(separator: ",")
        webView.evaluateJavaScript("window.EdgeTouch && EdgeTouch.frame([\(list)])", completionHandler: nil)
    }
}

/// A normal window on your main screen for editing the layout.
final class EditorController: NSObject, NSWindowDelegate {
    let window: NSWindow
    let webView: WKWebView

    init(bridge: Bridge) {
        webView = WebViewFactory.make(bridge: bridge, mode: "edit")
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1600, height: 1000)
        let width = min(1600, screen.width - 80)
        let height = min(1000, screen.height - 80)
        window = NSWindow(contentRect: NSRect(x: screen.midX - width / 2, y: screen.midY - height / 2,
                                              width: width, height: height),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "EdgeDeck — Edit Dashboard"
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.minSize = NSSize(width: 900, height: 600)
        super.init()
        window.delegate = self
        WebViewFactory.load(webView)
    }

    func show() {
        NSApp.setActivationPolicy(.regular)   // so the editor gets a Dock icon and keyboard focus
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        AppWindows.windowClosing(window)
    }
}

/// The settings window: one page per section, changes apply immediately.
final class SettingsController: NSObject, NSWindowDelegate {
    let window: NSWindow
    let webView: WKWebView

    init(bridge: Bridge) {
        webView = WebViewFactory.make(bridge: bridge, mode: "settings")
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 900)
        let width = min(1060, screen.width - 80)
        let height = min(760, screen.height - 80)
        window = NSWindow(contentRect: NSRect(x: screen.midX - width / 2, y: screen.midY - height / 2,
                                              width: width, height: height),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "EdgeDeck Settings"
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.minSize = NSSize(width: 820, height: 560)
        super.init()
        window.delegate = self
        WebViewFactory.load(webView)
    }

    func show() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        AppWindows.windowClosing(window)
    }
}

/// First-run setup: a step-by-step window; the Edge shows matching progress.
final class SetupController: NSObject, NSWindowDelegate {
    let window: NSWindow
    let webView: WKWebView
    var onClose: (() -> Void)?

    init(bridge: Bridge) {
        webView = WebViewFactory.make(bridge: bridge, mode: "setup")
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 900)
        let width = min(980, screen.width - 80)
        let height = min(720, screen.height - 80)
        window = NSWindow(contentRect: NSRect(x: screen.midX - width / 2, y: screen.midY - height / 2,
                                              width: width, height: height),
                          styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "Set Up EdgeDeck"
        window.isReleasedWhenClosed = false
        window.contentView = webView
        super.init()
        window.delegate = self
        WebViewFactory.load(webView)
    }

    func show() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        onClose?()
        AppWindows.windowClosing(window)
    }
}

/// EdgeDeck shows a Dock icon (and can take keyboard focus) only while the
/// editor, settings or setup window is open.
enum AppWindows {
    static func windowClosing(_ closing: NSWindow) {
        let othersOpen = NSApp.windows.contains { w in
            w !== closing && w.isVisible && w.styleMask.contains(.titled) && !(w is DashboardWindow)
        }
        if !othersOpen { NSApp.setActivationPolicy(.accessory) }
    }
}
