import Foundation

/// Runs AppleScript or JavaScript for Automation (JXA) through osascript and
/// returns its output, parsed as JSON when it is JSON. This lets integrations
/// with scriptable apps (OmniFocus, Things, Reminders, Mail…) live entirely in
/// the dashboard config. Scripts come from your own config, so they are as
/// trusted as the existing "Shell command" key action.
enum Scripts {
    struct Result {
        var value: Any?
        var error: String?
    }

    /// Blocking; call off the main thread.
    static func run(source: String, language: String, timeout: TimeInterval = 20) -> Result {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        // With no script file or -e, osascript reads the script from stdin,
        // which avoids argument-length limits and quoting problems.
        p.arguments = language.lowercased().hasPrefix("j") ? ["-l", "JavaScript"] : []
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        p.standardInput = stdin
        p.standardOutput = stdout
        p.standardError = stderr

        do { try p.run() } catch { return Result(error: error.localizedDescription) }
        stdin.fileHandleForWriting.write(source.data(using: .utf8) ?? Data())
        try? stdin.fileHandleForWriting.close()

        var timedOut = false
        let killer = DispatchWorkItem {
            if p.isRunning { timedOut = true; p.terminate() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)

        // Drain stderr concurrently so a chatty script can't fill the pipe and stall.
        var errData = Data()
        let errDone = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            errData = stderr.fileHandleForReading.readDataToEndOfFile()
            errDone.signal()
        }
        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        errDone.wait()
        killer.cancel()

        if timedOut { return Result(error: "Script took longer than \(Int(timeout)) seconds") }
        if p.terminationStatus != 0 {
            let message = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return Result(error: message.isEmpty ? "Script failed (exit \(p.terminationStatus))" : message)
        }
        let text = (String(data: outData, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let data = text.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
            return Result(value: json)
        }
        return Result(value: text)
    }
}
