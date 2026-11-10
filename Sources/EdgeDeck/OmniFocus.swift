import AppKit

/// OmniFocus integration (OmniFocus 4.7+ for planned dates).
///
/// OmniFocus can't report a perspective's contents without showing it in a
/// window, so EdgeDeck keeps its own OmniFocus document window parked on the
/// Edge display, underneath the full-screen dashboard where it's never seen,
/// switches that window to the requested perspective, and reads its content
/// tree with Omni Automation (`evaluate javascript`). That gives exactly the
/// rows, grouping and order the app shows. The window is recognised by its
/// position: any OmniFocus window whose top-left lies on the Edge is ours.
///
/// Requests run one at a time on a serial queue, since they share the window.
/// Needs Automation permission for OmniFocus (macOS asks the first time).
final class OmniFocusService {
    static let bundleID = "com.omnigroup.OmniFocus4"

    /// Supplies the Edge display's frame (nil if the Edge isn't connected).
    var edgeFrame: () -> NSRect? = { nil }

    private let queue = DispatchQueue(label: "edgedeck.omnifocus")

    var isRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleID).isEmpty
    }

    // MARK: Requests (completion on the main thread: value or error message)

    /// {custom: [names], builtin: [names]}
    func perspectives(_ done: @escaping (Any?, String?) -> Void) {
        run(done) {
            Self.tellOmniFocus(Self.evaluate("""
            (() => {
              const names = (list) => { try { return list.map((p) => p.name).filter(Boolean); } catch (e) { return []; } };
              return JSON.stringify({ custom: names(Perspective.Custom.all), builtin: names(Perspective.BuiltIn.all) });
            })()
            """))
        }
    }

    /// {perspective, rows: [{k:'g', n, d} | {k:'t', id, n, d, done, f, due, pl, epl, pr, tags, kids}]}
    func view(perspective: String, _ done: @escaping (Any?, String?) -> Void) {
        guard !perspective.isEmpty else { done(nil, "Choose a perspective in the editor"); return }
        guard let edge = edgeFrame() else { done(nil, "The Edge display wasn't found"); return }
        run(done) {
            let name = Self.appleScriptString(perspective)
            let e = edge.insetBy(dx: 40, dy: 40)
            let mainHeight = NSScreen.screens.first?.frame.height ?? edge.maxY
            // AppleScript bounds use a top-left origin on the main screen.
            let left = Int(edge.minX), right = Int(edge.maxX)
            let top = Int(mainHeight - edge.maxY), bottom = Int(mainHeight - edge.minY)
            let bounds = "{\(Int(e.minX)), \(Int(mainHeight - e.maxY)), \(Int(e.maxX)), \(Int(mainHeight - e.minY))}"
            return """
            tell application id "\(Self.bundleID)"
                local d, w, ids, b, lastCount, rowCount
                set d to default document
                set w to missing value
                -- Our window is the one parked on the Edge; close any duplicates.
                set ids to id of every document window of d
                repeat with i in ids
                    set b to bounds of document window id i of d
                    if (item 1 of b) ≥ \(left) and (item 1 of b) < \(right) and (item 2 of b) ≥ \(top) and (item 2 of b) < \(bottom) then
                        if w is missing value then
                            set w to document window id i of d
                        else
                            close document window id i of d
                        end if
                    end if
                end repeat
                if w is missing value then
                    tell d to set w to (make new document window with properties {bounds:\(bounds)})
                end if
                if (perspective name of w) is not "\(name)" then
                    set perspective name of w to "\(name)"
                    -- Wait until the content stops changing (at most ~2.5 s).
                    set lastCount to -1
                    repeat 12 times
                        delay 0.2
                        set rowCount to count of descendant trees of content of w
                        if rowCount = lastCount then exit repeat
                        set lastCount to rowCount
                    end repeat
                end if
                \(Self.evaluate(Self.readScript(perspective)))
            end tell
            """
        }
    }

    func complete(taskID: String, _ done: @escaping (Any?, String?) -> Void) {
        guard Self.isSafeID(taskID) else { done(nil, "Bad task id"); return }
        run(done) {
            Self.tellOmniFocus(Self.evaluate("""
            (() => {
              const t = Task.byIdentifier('\(taskID)');
              if (!t) return JSON.stringify({ error: 'That task no longer exists' });
              if (!t.completed) t.markComplete();
              return JSON.stringify({ ok: true });
            })()
            """))
        }
    }

    /// Sets the planned date (milliseconds since 1970), or clears it when nil.
    func plan(taskID: String, date: Double?, _ done: @escaping (Any?, String?) -> Void) {
        guard Self.isSafeID(taskID) else { done(nil, "Bad task id"); return }
        let value = date.map { "new Date(\(Int64($0)))" } ?? "null"
        run(done) {
            Self.tellOmniFocus(Self.evaluate("""
            (() => {
              const t = Task.byIdentifier('\(taskID)');
              if (!t) return JSON.stringify({ error: 'That task no longer exists' });
              t.plannedDate = \(value);
              return JSON.stringify({ ok: true });
            })()
            """))
        }
    }

    // MARK: Keeping a window for you

    private var watchTimer: Timer?
    private var checking = false
    private var lastCheckError: String?
    /// When we first saw OmniFocus in front with only EdgeDeck's hidden window.
    private var lostSince: Date?
    /// How long to wait after you close your window while OmniFocus stays in front.
    private let closeGrace: TimeInterval = 10

    /// EdgeDeck's parked window is hidden on the Edge. If you close the OmniFocus
    /// window you were using, that hidden one is all OmniFocus has left, and its Dock
    /// icon would only bring that forward, out of sight. So:
    /// - switching to OmniFocus from another app (Dock, ⌘-Tab) opens a window on the
    ///   main screen straight away if it has no visible one: you clearly want one;
    /// - closing your window while OmniFocus stays in front (the hidden window keeps
    ///   it there) waits 10 s first, so it doesn't pop straight back up. Switching
    ///   to another app in that time cancels it.
    func watchForLostWindow() {
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                          object: nil, queue: .main) { [weak self] note in
            guard let self = self else { return }
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            self.lostSince = nil
            if app?.bundleIdentifier == Self.bundleID {
                self.ensureVisibleWindow(openNow: true)
                if self.watchTimer == nil {
                    self.watchTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                        self?.ensureVisibleWindow(openNow: false)
                    }
                }
            } else {
                self.watchTimer?.invalidate()
                self.watchTimer = nil
            }
        }
    }

    private func ensureVisibleWindow(openNow: Bool) {
        guard !checking, isRunning, NSWorkspace.shared.frontmostApplication?.bundleIdentifier == Self.bundleID,
              let edge = edgeFrame(), let main = NSScreen.screens.first else { return }
        let mayOpen = openNow || (lostSince.map { Date().timeIntervalSince($0) >= closeGrace } ?? false)
        checking = true
        let mainHeight = main.frame.height
        // AppleScript bounds use a top-left origin on the main screen.
        let left = Int(edge.minX), right = Int(edge.maxX)
        let top = Int(mainHeight - edge.maxY), bottom = Int(mainHeight - edge.minY)
        let v = main.visibleFrame
        let w = min(1200, v.width - 80), h = min(800, v.height - 80)
        let x = Int(v.midX - w / 2), y = Int(mainHeight - v.midY - h / 2)
        let bounds = "{\(x), \(y), \(x + Int(w)), \(y + Int(h))}"
        // Replies "visible" (you have a window), "none" (no windows at all),
        // "hidden" (only EdgeDeck's, on the Edge) or "opened".
        let script = """
        tell application id "\(Self.bundleID)"
            local d, total, onEdge, b, ids
            set d to default document
            set ids to id of every document window of d
            set total to count of ids
            if total = 0 then return "none"
            set onEdge to 0
            repeat with i in ids
                set b to bounds of document window id i of d
                if (item 1 of b) ≥ \(left) and (item 1 of b) < \(right) and (item 2 of b) ≥ \(top) and (item 2 of b) < \(bottom) then set onEdge to onEdge + 1
            end repeat
            if total > onEdge then return "visible"
            if \(mayOpen ? "true" : "false") then
                tell d to make new document window with properties {bounds:\(bounds)}
                return "opened"
            end if
            return "hidden"
        end tell
        """
        queue.async { [weak self] in
            let r = Scripts.run(source: script, language: "applescript", timeout: 10)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.checking = false
                switch r.value as? String {
                case "opened":
                    self.lostSince = nil
                    Log.write("OmniFocus: opened a window on the main screen (" +
                              (openNow ? "switched to OmniFocus" : "still in front 10 s after its last window closed") +
                              "; the only other one is EdgeDeck's, on the Edge)")
                case "hidden":
                    if self.lostSince == nil { self.lostSince = Date() }
                default:
                    self.lostSince = nil
                }
                // Log a failure once, not every 2 seconds.
                if let e = r.error, e != self.lastCheckError { Log.write("OmniFocus: couldn't check its windows: \(e)") }
                self.lastCheckError = r.error
            }
        }
    }

    /// Opens OmniFocus (it needs to be running for everything else).
    func launch() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleID) else { return }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        NSWorkspace.shared.openApplication(at: url, configuration: config, completionHandler: nil)
    }

    // MARK: Plumbing

    private func run(_ done: @escaping (Any?, String?) -> Void, script: @escaping () -> String) {
        guard isRunning else { done(nil, "OmniFocus isn't open"); return }
        queue.async {
            let r = Scripts.run(source: script(), language: "applescript", timeout: 30)
            var value = r.value
            var error = r.error
            if let dict = value as? [String: Any], let e = dict["error"] as? String {
                error = e
                value = nil
            }
            if let e = error { Log.write("OmniFocus: \(e)") }
            DispatchQueue.main.async { done(value, error) }
        }
    }

    private static func tellOmniFocus(_ body: String) -> String {
        "tell application id \"\(bundleID)\"\n\(body)\nend tell"
    }

    /// An AppleScript `evaluate javascript` line that returns the script's result.
    private static func evaluate(_ js: String) -> String {
        "return evaluate javascript \"\(appleScriptString(js))\""
    }

    private static func appleScriptString(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func isSafeID(_ id: String) -> Bool {
        !id.isEmpty && id.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." }
    }

    /// Omni Automation that serialises the window showing `perspective`.
    private static func readScript(_ perspective: String) -> String {
        let name = perspective.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        return """
        (() => {
          const P = '\(name)';
          const win = document.windows.find((w) => { try { return w.perspective && w.perspective.name === P; } catch (e) { return false; } });
          if (!win) return JSON.stringify({ error: 'OmniFocus didn’t show the perspective “' + P + '”' });
          const ms = (d) => (d ? d.getTime() : null);
          const rows = [];
          const walk = (node, depth) => {
            for (const child of node.children) {
              if (rows.length >= 200) return;
              const o = child.object;
              if (o instanceof Task) {
                let epl = null;
                try { epl = ms(o.effectivePlannedDate); } catch (e) {}
                rows.push({ k: 't', id: o.id.primaryKey, n: o.name, d: depth, done: o.completed, f: o.flagged,
                  due: ms(o.effectiveDueDate), pl: ms(o.plannedDate), epl: epl,
                  pr: o.containingProject ? o.containingProject.name : '', tags: o.tags.map((t) => t.name),
                  kids: child.children.length > 0 });
              } else {
                rows.push({ k: 'g', n: (o && o.name) || '', d: depth });
              }
              walk(child, depth + 1);
            }
          };
          walk(win.content.rootNode, 0);
          return JSON.stringify({ perspective: P, rows: rows });
        })()
        """
    }
}
