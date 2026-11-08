import Foundation

/// One input field in a HID report, with its position in the report.
struct HIDField {
    let reportID: UInt8
    let bitOffset: Int      // offset from the start of the report payload (after any report ID byte)
    let bitSize: Int
    let usagePage: UInt32
    let usage: UInt32
    let logicalMin: Int
    let logicalMax: Int
    let isRelative: Bool
    let collection: Int     // innermost collection instance this field sits in
    let collectionPath: [Int]

    func value(in payload: UnsafePointer<UInt8>, length: Int) -> Int? {
        guard bitSize > 0, bitSize <= 32 else { return nil }
        guard (bitOffset + bitSize + 7) / 8 <= length else { return nil }
        var raw: UInt64 = 0
        for b in 0..<bitSize {
            let bit = bitOffset + b
            if (payload[bit >> 3] >> UInt8(bit & 7)) & 1 == 1 {
                raw |= (1 << UInt64(b))
            }
        }
        if logicalMin < 0, bitSize < 64, raw & (1 << UInt64(bitSize - 1)) != 0 {
            // Sign-extend
            return Int(Int64(bitPattern: raw | (~0 << UInt64(bitSize))))
        }
        return Int(raw)
    }
}

/// Minimal HID report descriptor parser. Handles the items used by
/// touch screens and pointers: usage pages, usages, usage ranges,
/// logical min/max, report size/count/ID, push/pop and collections.
struct HIDDescriptor {
    var fields: [HIDField] = []
    var usesReportIDs = false
    var collectionUsages: [Int: (page: UInt32, usage: UInt32)] = [:]

    /// The collection that represents one contact: the innermost Finger,
    /// Stylus or Pointer collection containing the field, so fields in a
    /// nested physical collection still pair with their tip switch and ID.
    func groupKey(for f: HIDField) -> Int {
        for c in f.collectionPath.reversed() {
            if let u = collectionUsages[c],
               (u.page == 0x0D && (u.usage == 0x22 || u.usage == 0x20)) || (u.page == 0x01 && u.usage == 0x01) {
                return c
            }
        }
        return f.collection
    }

    static func parse(_ bytes: [UInt8]) -> HIDDescriptor {
        var result = HIDDescriptor()

        struct Globals {
            var usagePage: UInt32 = 0
            var logicalMin: Int = 0
            var logicalMaxSigned: Int = 0
            var logicalMaxUnsigned: Int = 0
            var reportSize: Int = 0
            var reportCount: Int = 0
            var reportID: UInt8 = 0
        }

        var g = Globals()
        var globalStack: [Globals] = []
        var usages: [UInt32] = []           // (page << 16) | usage
        var usageMin: UInt32?
        var usageMax: UInt32?
        var collectionStack: [Int] = []
        var collectionCounter = 0
        var inputOffsets: [UInt8: Int] = [:]

        func fullUsage(_ value: UInt32, size: Int) -> UInt32 {
            size == 4 ? value : (g.usagePage << 16) | (value & 0xFFFF)
        }

        func clearLocals() {
            usages.removeAll()
            usageMin = nil
            usageMax = nil
        }

        var i = 0
        while i < bytes.count {
            let prefix = bytes[i]
            if prefix == 0xFE { // long item
                guard i + 1 < bytes.count else { break }
                i += 3 + Int(bytes[i + 1])
                continue
            }
            let sizeCode = Int(prefix & 0x03)
            let size = sizeCode == 3 ? 4 : sizeCode
            let type = (prefix >> 2) & 0x03
            let tag = (prefix >> 4) & 0x0F
            guard i + 1 + size <= bytes.count else { break }

            var u: UInt32 = 0
            for k in 0..<size { u |= UInt32(bytes[i + 1 + k]) << UInt32(8 * k) }
            let s: Int
            switch size {
            case 1: s = Int(Int8(bitPattern: UInt8(truncatingIfNeeded: u)))
            case 2: s = Int(Int16(bitPattern: UInt16(truncatingIfNeeded: u)))
            case 4: s = Int(Int32(bitPattern: u))
            default: s = 0
            }
            i += 1 + size

            switch type {
            case 0: // Main
                switch tag {
                case 0x8: // Input
                    let isConstant = u & 0x01 != 0
                    let isVariable = u & 0x02 != 0
                    let isRelative = u & 0x04 != 0
                    var offset = inputOffsets[g.reportID] ?? 0
                    let logicalMax = g.logicalMin < 0 ? g.logicalMaxSigned : g.logicalMaxUnsigned
                    for n in 0..<max(g.reportCount, 0) {
                        if !isConstant && isVariable {
                            var usage: UInt32 = 0
                            if !usages.isEmpty {
                                usage = usages[min(n, usages.count - 1)]
                            } else if let lo = usageMin, let hi = usageMax {
                                usage = min(lo + UInt32(n), hi)
                            }
                            result.fields.append(HIDField(
                                reportID: g.reportID,
                                bitOffset: offset,
                                bitSize: g.reportSize,
                                usagePage: usage >> 16,
                                usage: usage & 0xFFFF,
                                logicalMin: g.logicalMin,
                                logicalMax: logicalMax,
                                isRelative: isRelative,
                                collection: collectionStack.last ?? 0,
                                collectionPath: collectionStack))
                        }
                        offset += g.reportSize
                    }
                    inputOffsets[g.reportID] = offset
                    clearLocals()
                case 0xA: // Collection
                    collectionCounter += 1
                    collectionStack.append(collectionCounter)
                    if let first = usages.first {
                        result.collectionUsages[collectionCounter] = (first >> 16, first & 0xFFFF)
                    }
                    clearLocals()
                case 0xC: // End collection
                    _ = collectionStack.popLast()
                    clearLocals()
                default: // Output, Feature
                    clearLocals()
                }
            case 1: // Global
                switch tag {
                case 0x0: g.usagePage = u
                case 0x1: g.logicalMin = s
                case 0x2: g.logicalMaxSigned = s; g.logicalMaxUnsigned = Int(u)
                case 0x7: g.reportSize = Int(u)
                case 0x8: g.reportID = UInt8(truncatingIfNeeded: u); result.usesReportIDs = true
                case 0x9: g.reportCount = Int(u)
                case 0xA: globalStack.append(g)
                case 0xB: if let top = globalStack.popLast() { g = top }
                default: break
                }
            case 2: // Local
                switch tag {
                case 0x0: usages.append(fullUsage(u, size: size))
                case 0x1: usageMin = fullUsage(u, size: size)
                case 0x2: usageMax = fullUsage(u, size: size)
                default: break
                }
            default:
                break
            }
        }
        return result
    }
}

// MARK: - Touch interpretation

struct TouchContact: Equatable {
    let id: Int
    let x: Double   // 0...1 across the panel
    let y: Double   // 0...1 down the panel
}

/// Turns raw input reports into a set of current touch contacts.
/// Supports Windows-style multi-touch digitizers (including "hybrid"
/// mode where contacts are split across several reports) and falls back
/// to a single absolute pointer.
final class TouchInterpreter {
    struct Slot {
        var x: HIDField
        var y: HIDField
        var tip: HIDField?
        var inRange: HIDField?
        var contactID: HIDField?
    }

    /// One way of reading touches: the X/Y slots found in a single input report.
    struct Mode {
        let reportID: UInt8
        let slots: [Slot]
        let contactCount: HIDField?
        let isDigitizer: Bool
        var score: Int { (isDigitizer ? 1000 : 0) + slots.count }
    }

    let descriptor: HIDDescriptor
    /// Every input report that carries usable X/Y, keyed by report ID.
    private(set) var modes: [UInt8: Mode] = [:]
    /// The best mode the descriptor offers (used for the summary and interface choice).
    private(set) var best: Mode?
    /// The mode currently being followed: the best-scoring report actually received.
    private var active: Mode?

    var reportID: UInt8 { best?.reportID ?? 0 }
    var slots: [Slot] { best?.slots ?? [] }
    var contactCount: HIDField? { best?.contactCount }
    var isDigitizer: Bool { best?.isDigitizer ?? false }

    private var contacts: [Int: TouchContact] = [:]
    private var expected = 0
    private var received = 0
    private var seen = Set<Int>()

    var isUsable: Bool { best != nil }

    init(descriptor: HIDDescriptor) {
        self.descriptor = descriptor
        choose()
    }

    private func choose() {
        // Group absolute X/Y fields by report and collection.
        var byReport: [UInt8: [Int: [HIDField]]] = [:]
        for f in descriptor.fields where !f.isRelative {
            byReport[f.reportID, default: [:]][descriptor.groupKey(for: f), default: []].append(f)
        }

        for (rid, collections) in byReport {
            var reportSlots: [Slot] = []
            var digitizer = false
            for key in collections.keys.sorted() {
                let fs = collections[key]!
                guard let x = fs.first(where: { $0.usagePage == 0x01 && $0.usage == 0x30 }),
                      let y = fs.first(where: { $0.usagePage == 0x01 && $0.usage == 0x31 }) else { continue }
                let tip = fs.first(where: { $0.usagePage == 0x0D && $0.usage == 0x42 })
                    ?? fs.first(where: { $0.usagePage == 0x09 && $0.usage == 0x01 })
                let inRange = fs.first(where: { $0.usagePage == 0x0D && $0.usage == 0x32 })
                let cid = fs.first(where: { $0.usagePage == 0x0D && $0.usage == 0x51 })
                if cid != nil || (tip?.usagePage == 0x0D) { digitizer = true }
                reportSlots.append(Slot(x: x, y: y, tip: tip, inRange: inRange, contactID: cid))
            }
            guard !reportSlots.isEmpty else { continue }
            let cc = descriptor.fields.first {
                $0.reportID == rid && $0.usagePage == 0x0D && $0.usage == 0x54
            }
            let mode = Mode(reportID: rid, slots: reportSlots, contactCount: cc, isDigitizer: digitizer)
            modes[rid] = mode
            // Prefer digitizers, then more contacts.
            if best == nil || mode.score > best!.score { best = mode }
        }
    }

    /// The score of the mode this report would be read with, or nil if it carries no touches.
    func score(forReport bytes: UnsafePointer<UInt8>, length: Int) -> Int? {
        guard length > 0 else { return nil }
        return modes[descriptor.usesReportIDs ? bytes[0] : 0]?.score
    }

    var summary: String {
        guard let b = best else { return "no usable X/Y fields" }
        let kind = b.isDigitizer ? "multi-touch digitizer" : "absolute pointer"
        let x = b.slots[0].x
        let y = b.slots[0].y
        let others = modes.keys.filter { $0 != b.reportID }.sorted().map { String($0) }
        var text = "\(kind), report ID \(b.reportID), \(b.slots.count) contact slot(s), "
        text += "contact count field: \(b.contactCount != nil ? "yes" : "no"), "
        text += "X \(x.logicalMin)...\(x.logicalMax), Y \(y.logicalMin)...\(y.logicalMax)"
        if !others.isEmpty { text += ", fallback report ID(s) \(others.joined(separator: ","))" }
        return text
    }

    /// Feed one input report. `bytes` is the full report as delivered by IOKit
    /// (including the report ID byte when the device uses report IDs).
    /// Returns the full contact list when a frame is complete, otherwise nil.
    func handle(report bytes: UnsafePointer<UInt8>, length: Int) -> [TouchContact]? {
        guard length > 0 else { return nil }
        var payload = bytes
        var payloadLength = length
        let rid: UInt8 = descriptor.usesReportIDs ? bytes[0] : 0
        if descriptor.usesReportIDs {
            payload = bytes + 1
            payloadLength = length - 1
        }
        guard let mode = modes[rid] else { return nil }

        // Follow the best-scoring report the device actually sends. Devices that
        // start in mouse mode only send their pointer report; if they later send
        // digitizer reports we switch up and ignore the pointer report from then on.
        if let a = active, a.reportID != rid {
            guard mode.score > a.score else { return nil }
            active = mode
            contacts.removeAll(); seen.removeAll(); expected = 0; received = 0
        } else if active == nil {
            active = mode
        }
        let slots = mode.slots

        var valid = slots.count
        if let cc = mode.contactCount, let count = cc.value(in: payload, length: payloadLength) {
            if count > 0 {
                expected = count
                received = 0
                seen.removeAll()
            } else if received >= expected {
                // Not continuing a hybrid frame: a count of 0 means nothing is touching.
                expected = 0
                received = 0
                seen.removeAll()
            }
            valid = min(slots.count, max(0, expected - received))
        } else {
            seen.removeAll()
        }

        for (index, slot) in slots.prefix(valid).enumerated() {
            guard let rx = slot.x.value(in: payload, length: payloadLength),
                  let ry = slot.y.value(in: payload, length: payloadLength) else { continue }
            var down = true
            if let tip = slot.tip, let v = tip.value(in: payload, length: payloadLength) {
                down = v != 0
            } else if let r = slot.inRange, let v = r.value(in: payload, length: payloadLength) {
                down = v != 0
            }
            let id = slot.contactID.flatMap { $0.value(in: payload, length: payloadLength) } ?? index
            if down {
                let nx = normalise(rx, slot.x)
                let ny = normalise(ry, slot.y)
                contacts[id] = TouchContact(id: id, x: nx, y: ny)
                seen.insert(id)
            } else {
                contacts.removeValue(forKey: id)
            }
        }

        if mode.contactCount != nil {
            received += valid
            guard received >= expected else { return nil }
        }
        // Frame complete: anything not reported in this frame has lifted.
        for id in contacts.keys where !seen.contains(id) {
            contacts.removeValue(forKey: id)
        }
        return contacts.values.sorted { $0.id < $1.id }
    }

    private func normalise(_ v: Int, _ f: HIDField) -> Double {
        let span = Double(f.logicalMax - f.logicalMin)
        guard span > 0 else { return 0 }
        return min(1, max(0, Double(v - f.logicalMin) / span))
    }
}
