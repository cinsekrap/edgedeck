import Foundation
import Darwin
import IOKit.ps

/// CPU, memory, network, disk and battery figures from public macOS APIs.
/// No permissions needed. CPU and network are rates, so they are measured
/// between calls; snapshots are cached for a second so several widgets
/// polling at once don't shrink the measuring window to nothing.
final class SystemStats {
    static let shared = SystemStats()

    private let host = mach_host_self()
    private let lock = NSLock()
    private var lastCPU: host_cpu_load_info?
    private var lastNet: [String: (rx: UInt32, tx: UInt32)] = [:]
    private var lastNetTime: Date?
    private var cached: (time: Date, value: [String: Any])?

    private init() {
        _ = cpu()          // seed the first CPU sample
        _ = network()      // and the first network sample
    }

    func snapshot() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        if let c = cached, Date().timeIntervalSince(c.time) < 0.9 { return c.value }
        var out: [String: Any] = ["memory": memory()]
        if let c = cpu() { out["cpu"] = c }
        if let n = network() { out["network"] = n }
        if let d = disk() { out["disk"] = d }
        if let b = battery() { out["battery"] = b }
        cached = (Date(), out)
        return out
    }

    // MARK: CPU

    /// Percentage of all cores busy since the previous call.
    private func cpu() -> Double? {
        var info = host_cpu_load_info()
        var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics(host, HOST_CPU_LOAD_INFO, $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        defer { lastCPU = info }
        guard let last = lastCPU else { return nil }
        let t = info.cpu_ticks, l = last.cpu_ticks   // (user, system, idle, nice)
        let user = Double(t.0 &- l.0), system = Double(t.1 &- l.1)
        let idle = Double(t.2 &- l.2), nice = Double(t.3 &- l.3)
        let total = user + system + idle + nice
        guard total > 0 else { return nil }
        return (user + system + nice) / total * 100
    }

    // MARK: Memory

    /// "Memory used" roughly as Activity Monitor shows it: app + wired + compressed.
    private func memory() -> [String: Any] {
        let total = ProcessInfo.processInfo.physicalMemory
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(host, HOST_VM_INFO64, $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return ["total": total] }
        var pageSize: vm_size_t = 0
        host_page_size(host, &pageSize)
        let page = UInt64(pageSize)
        let app = UInt64(stats.internal_page_count) &- UInt64(stats.purgeable_count)
        let used = (app + UInt64(stats.wire_count) + UInt64(stats.compressor_page_count)) * page
        return ["used": min(used, total), "total": total]
    }

    // MARK: Network

    /// Bytes per second received and sent across Wi-Fi/Ethernet ("en*")
    /// interfaces. VPN tunnels are skipped so traffic isn't counted twice.
    private func network() -> [String: Any]? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0 else { return nil }
        defer { freeifaddrs(ifaddr) }

        var now: [String: (rx: UInt32, tx: UInt32)] = [:]
        var p = ifaddr
        while let a = p {
            let ifa = a.pointee
            p = ifa.ifa_next
            guard let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_LINK),
                  let data = ifa.ifa_data,
                  ifa.ifa_flags & UInt32(IFF_UP) != 0, ifa.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            let name = String(cString: ifa.ifa_name)
            guard name.hasPrefix("en") else { continue }
            let d = data.assumingMemoryBound(to: if_data.self).pointee
            now[name] = (d.ifi_ibytes, d.ifi_obytes)
        }

        let time = Date()
        defer { lastNet = now; lastNetTime = time }
        guard let lastTime = lastNetTime else { return nil }
        let seconds = time.timeIntervalSince(lastTime)
        guard seconds > 0 else { return nil }
        var rx: UInt64 = 0, tx: UInt64 = 0
        for (name, v) in now {
            guard let old = lastNet[name] else { continue }
            // The counters are 32-bit and wrap; &- gives the right delta across one wrap.
            rx += UInt64(v.rx &- old.rx)
            tx += UInt64(v.tx &- old.tx)
        }
        return ["rx": Double(rx) / seconds, "tx": Double(tx) / seconds]
    }

    // MARK: Disk

    private func disk() -> [String: Any]? {
        let keys: Set<URLResourceKey> = [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey]
        guard let v = try? URL(fileURLWithPath: "/").resourceValues(forKeys: keys),
              let total = v.volumeTotalCapacity, let free = v.volumeAvailableCapacityForImportantUsage else { return nil }
        return ["total": Int64(total), "free": free]
    }

    // MARK: Battery

    /// nil on Macs without a battery.
    private func battery() -> [String: Any]? {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return nil }
        for source in list {
            guard let d = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                  (d[kIOPSTypeKey] as? String) == kIOPSInternalBatteryType,
                  let current = d[kIOPSCurrentCapacityKey] as? Int,
                  let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 else { continue }
            return [
                "percent": Double(current) / Double(max) * 100,
                "charging": d[kIOPSIsChargingKey] as? Bool ?? false,
                "pluggedIn": (d[kIOPSPowerSourceStateKey] as? String) == kIOPSACPowerValue,
            ]
        }
        return nil
    }
}
