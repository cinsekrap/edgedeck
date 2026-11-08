import AppKit
import EventKit

/// Upcoming events from every calendar account set up on the Mac (iCloud,
/// Google, Exchange…) via EventKit. Needs Calendar permission, which macOS
/// asks for the first time a calendar widget loads.
final class CalendarSource {
    static let shared = CalendarSource()

    private var store = EKEventStore()

    var status: String {
        let s = EKEventStore.authorizationStatus(for: .event)
        if #available(macOS 14.0, *) {
            if s == .fullAccess { return "granted" }
            if s == .writeOnly { return "write-only" }
        }
        switch s {
        case .authorized: return "granted"
        case .notDetermined: return "not asked"
        case .denied: return "denied"
        case .restricted: return "restricted"
        default: return "unknown"
        }
    }

    private func requestAccess(_ done: @escaping (Bool) -> Void) {
        let finish: (Bool, Error?) -> Void = { granted, error in
            if let error = error { Log.write("Calendar access error: \(error.localizedDescription)") }
            DispatchQueue.main.async {
                // A store created before access was granted can stay empty; start fresh.
                if granted { self.store = EKEventStore() }
                done(granted)
            }
        }
        if #available(macOS 14.0, *) {
            store.requestFullAccessToEvents(completion: finish)
        } else {
            store.requestAccess(to: .event, completion: finish)
        }
    }

    /// Calls back on the main thread with events, or an error message.
    func events(days: Int, limit: Int, calendars: [String], includeAllDay: Bool,
                completion: @escaping ([[String: Any]]?, String?) -> Void) {
        switch status {
        case "granted":
            completion(fetch(days: days, limit: limit, calendars: calendars, includeAllDay: includeAllDay), nil)
        case "not asked":
            requestAccess { granted in
                if granted {
                    completion(self.fetch(days: days, limit: limit, calendars: calendars, includeAllDay: includeAllDay), nil)
                } else {
                    completion(nil, "Calendar access was not allowed")
                }
            }
        default:
            completion(nil, "Allow EdgeDeck in System Settings → Privacy & Security → Calendars")
        }
    }

    private func fetch(days: Int, limit: Int, calendars: [String], includeAllDay: Bool) -> [[String: Any]] {
        let now = Date()
        let cal = Calendar.current
        let startOfToday = cal.startOfDay(for: now)
        let end = cal.date(byAdding: .day, value: max(1, days), to: startOfToday) ?? now.addingTimeInterval(86_400)

        let wanted = calendars.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
        let sources = store.calendars(for: .event).filter { wanted.isEmpty || wanted.contains($0.title.lowercased()) }
        guard !sources.isEmpty else { return [] }

        // Start at the beginning of today so events already in progress are included.
        let predicate = store.predicateForEvents(withStart: startOfToday, end: end, calendars: sources)
        let events = store.events(matching: predicate)
            .filter { $0.endDate > now && (includeAllDay || !$0.isAllDay) && $0.status != .canceled }
            .sorted { $0.startDate < $1.startDate }

        return events.prefix(max(1, limit)).map { e in
            var item: [String: Any] = [
                "title": e.title ?? "Untitled",
                "start": e.startDate.timeIntervalSince1970 * 1000,
                "end": e.endDate.timeIntervalSince1970 * 1000,
                "allDay": e.isAllDay,
                "calendar": e.calendar.title,
                "color": Self.hex(e.calendar.color),
            ]
            if let loc = e.location, !loc.isEmpty { item["location"] = loc }
            if let join = Self.joinURL(e) { item["joinURL"] = join }
            return item
        }
    }

    private static let meetingHosts = ["zoom.us", "meet.google.com", "teams.microsoft.com", "teams.live.com",
                                       "webex.com", "facetime.apple.com", "whereby.com", "around.co"]

    /// A video-call link from the event's URL, location or notes, if there is one.
    private static func joinURL(_ e: EKEvent) -> String? {
        var candidates: [String] = []
        if let u = e.url?.absoluteString { candidates.append(u) }
        let text = [e.location, e.notes].compactMap { $0 }.joined(separator: "\n")
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            for m in detector.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                if let u = m.url?.absoluteString { candidates.append(u) }
            }
        }
        return candidates.first { url in
            guard let host = URL(string: url)?.host?.lowercased() else { return false }
            return meetingHosts.contains { host == $0 || host.hasSuffix("." + $0) }
        }
    }

    private static func hex(_ color: NSColor?) -> String {
        guard let c = color?.usingColorSpace(.sRGB) else { return "#4cc2ff" }
        return String(format: "#%02x%02x%02x", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }
}
