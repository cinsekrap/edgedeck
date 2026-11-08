import Foundation
import IOKit
import IOKit.hid

/// Reads the Xeneon Edge touch controller directly over USB HID and takes
/// exclusive control of it, so macOS stops turning touches into cursor
/// movement. Touches are delivered as normalised contacts instead.
final class TouchReader {
    /// Called on the main thread with every contact currently on the glass.
    var onContacts: (([TouchContact]) -> Void)?
    /// Called when the device connects/disconnects or access changes.
    var onStatus: ((String) -> Void)?

    /// When > 0, raw reports are written to the log (counts down).
    var rawLogBudget = 0

    private(set) var status = "Not started"
    private var settings = ConfigStore.DeviceSettings()
    private var manager: IOHIDManager?
    private var devices: [DeviceState] = []

    final class DeviceState {
        let device: IOHIDDevice
        let interpreter: TouchInterpreter
        let buffer: UnsafeMutablePointer<UInt8>
        let bufferSize: Int
        weak var reader: TouchReader?

        init(device: IOHIDDevice, interpreter: TouchInterpreter, bufferSize: Int) {
            self.device = device
            self.interpreter = interpreter
            self.bufferSize = bufferSize
            self.buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        }

        deinit { buffer.deallocate() }
    }

    // MARK: Permissions

    static var hasInputMonitoringAccess: Bool {
        IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
    }

    static func requestInputMonitoringAccess() {
        _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
    }

    // MARK: Lifecycle

    func start() {
        stop()
        settings = ConfigStore.shared.device
        let access = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
        Log.write("Input Monitoring: " + (access == kIOHIDAccessTypeGranted ? "granted"
                                         : access == kIOHIDAccessTypeDenied ? "denied" : "not decided yet"))
        let m = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        let matching: [String: Any] = [
            kIOHIDVendorIDKey as String: settings.vendorID,
            kIOHIDProductIDKey as String: settings.productID,
        ]
        IOHIDManagerSetDeviceMatching(m, matching as CFDictionary)

        let context = Unmanaged.passUnretained(self).toOpaque()
        IOHIDManagerRegisterDeviceMatchingCallback(m, { context, _, _, device in
            guard let context = context else { return }
            Unmanaged<TouchReader>.fromOpaque(context).takeUnretainedValue().attach(device)
        }, context)
        IOHIDManagerRegisterDeviceRemovalCallback(m, { context, _, _, device in
            guard let context = context else { return }
            Unmanaged<TouchReader>.fromOpaque(context).takeUnretainedValue().detach(device)
        }, context)

        IOHIDManagerScheduleWithRunLoop(m, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)

        // Seize = exclusive access, so the system no longer moves the cursor.
        var result = IOHIDManagerOpen(m, IOOptionBits(kIOHIDOptionsTypeSeizeDevice))
        if result != kIOReturnSuccess {
            Log.write("Exclusive open failed (0x\(String(UInt32(bitPattern: result), radix: 16))); trying shared open")
            result = IOHIDManagerOpen(m, IOOptionBits(kIOHIDOptionsTypeNone))
            if result != kIOReturnSuccess {
                setStatus("Could not open touch controller — check Input Monitoring permission")
            } else {
                setStatus("Touch opened without exclusive access — the cursor may still move")
            }
        } else {
            setStatus(devices.isEmpty ? "Waiting for Xeneon Edge touch controller" : status)
        }
        manager = m
        Log.write(String(format: "Touch reader started for %04X:%04X", settings.vendorID, settings.productID))
    }

    /// Re-read orientation settings after the config is saved.
    func reloadSettings() {
        let new = ConfigStore.shared.device
        let deviceChanged = new.vendorID != settings.vendorID || new.productID != settings.productID
        settings = new
        if deviceChanged { start() }
    }

    func stop() {
        if let m = manager {
            IOHIDManagerUnscheduleFromRunLoop(m, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            IOHIDManagerClose(m, IOOptionBits(kIOHIDOptionsTypeNone))
        }
        manager = nil
        devices.removeAll()
        active = nil
        activeScore = Int.min
    }

    private func setStatus(_ s: String) {
        status = s
        Log.write("Touch: \(s)")
        onStatus?(s)
    }

    // MARK: Devices

    private func attach(_ device: IOHIDDevice) {
        guard let descriptorData = IOHIDDeviceGetProperty(device, kIOHIDReportDescriptorKey as CFString) as? Data else {
            Log.write("Matched a device without a report descriptor; ignoring")
            return
        }
        let bytes = [UInt8](descriptorData)
        let descriptor = HIDDescriptor.parse(bytes)
        let interpreter = TouchInterpreter(descriptor: descriptor)
        let usagePage = IOHIDDeviceGetProperty(device, kIOHIDPrimaryUsagePageKey as CFString) as? Int ?? 0
        let usage = IOHIDDeviceGetProperty(device, kIOHIDPrimaryUsageKey as CFString) as? Int ?? 0

        Log.write("HID interface attached: primary usage \(String(format: "0x%02X/0x%02X", usagePage, usage)), " +
                  "\(bytes.count)-byte descriptor, \(descriptor.fields.count) input fields, " +
                  interpreter.summary)

        var size = IOHIDDeviceGetProperty(device, kIOHIDMaxInputReportSizeKey as CFString) as? Int ?? 64
        if size <= 0 { size = 64 }
        let state = DeviceState(device: device, interpreter: interpreter, bufferSize: size)
        state.reader = self
        devices.append(state)

        let context = Unmanaged.passUnretained(state).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(device, state.buffer, size, { context, _, _, _, _, report, length in
            guard let context = context else { return }
            let state = Unmanaged<DeviceState>.fromOpaque(context).takeUnretainedValue()
            state.reader?.handle(report: UnsafePointer(report), length: Int(length), from: state)
        }, context)

        // (The Edge also advertises a multi-touch digitizer, but on macOS it only ever sends
        // single-contact pointer reports, even when asked to switch modes.)
        if devices.contains(where: { $0.interpreter.isUsable }) { setStatus("Touch connected") }
    }

    private func detach(_ device: IOHIDDevice) {
        devices.removeAll { $0.device === device }
        if active == nil || active?.device === device { active = nil; activeScore = Int.min }
        Log.write("HID interface removed")
        if devices.isEmpty { setStatus("Xeneon Edge touch controller disconnected") }
    }

    /// The interface we currently take touches from: the one sending the
    /// best-scoring touch reports (digitizer over pointer) seen so far.
    private weak var active: DeviceState?
    private var activeScore = Int.min

    private func handle(report: UnsafePointer<UInt8>, length: Int, from state: DeviceState) {
        if rawLogBudget > 0 {
            rawLogBudget -= 1
            let hex = (0..<length).map { String(format: "%02X", report[$0]) }.joined(separator: " ")
            Log.write("Report (\(length) bytes): \(hex)")
        }
        guard let score = state.interpreter.score(forReport: report, length: length) else { return }
        if active !== state {
            guard active == nil || score > activeScore else { return }
            active = state
            activeScore = score
        } else {
            activeScore = max(activeScore, score)
        }
        guard let contacts = state.interpreter.handle(report: report, length: length) else { return }

        let s = settings
        let mapped = contacts.map { c -> TouchContact in
            var x = c.x, y = c.y
            if s.swapXY { swap(&x, &y) }
            if s.flipX { x = 1 - x }
            if s.flipY { y = 1 - y }
            return TouchContact(id: c.id, x: x, y: y)
        }
        if rawLogBudget > 0 {
            Log.write("Contacts: " + mapped.map { String(format: "#%d (%.3f, %.3f)", $0.id, $0.x, $0.y) }.joined(separator: ", "))
        }
        onContacts?(mapped)
    }
}
