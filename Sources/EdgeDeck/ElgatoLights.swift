import Foundation

/// Elgato Key Lights (and other lights using the same local API) on the
/// network. They advertise themselves over Bonjour as _elg._tcp and accept
/// plain HTTP on port 9123 with no authentication:
///   GET  /elgato/accessory-info   name, model, firmware, serial
///   GET  /elgato/lights           {"numberOfLights":1,"lights":[{"on":0|1,"brightness":0-100,"temperature":143-344}]}
///   PUT  /elgato/lights           same shape, any subset of fields
/// (Temperature is in mireds: 143 = 7000 K, 344 = 2900 K.) The newer Key
/// Light Air MK.2 uses a different, encrypted protocol and isn't supported.
/// Browsing the local network needs macOS's Local Network permission.
final class ElgatoLights: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    struct Light {
        let id: String          // Bonjour service name, stable per light
        var host: String
        var port: Int
        var name: String
    }

    private let browser = NetServiceBrowser()
    private var resolving: [NetService] = []
    private(set) var lights: [String: Light] = [:]
    private var started = false
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 2.5
        return URLSession(configuration: c)
    }()

    /// Starts browsing (on first use, so the Local Network prompt only appears
    /// once a lights widget or setting needs it).
    func start() {
        guard !started else { return }
        started = true
        browser.delegate = self
        browser.searchForServices(ofType: "_elg._tcp.", inDomain: "local.")
        Log.write("Elgato: looking for lights")
    }

    // MARK: Bonjour

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        service.delegate = self
        resolving.append(service)
        service.resolve(withTimeout: 5)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        lights[service.name] = nil
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        resolving.removeAll { $0 === sender }
        guard let host = sender.hostName else { return }
        let known = lights[sender.name]
        lights[sender.name] = Light(id: sender.name, host: host, port: sender.port, name: known?.name ?? Self.friendlyName(sender.name))
        if known == nil {
            Log.write("Elgato: found \(sender.name) at \(host):\(sender.port)")
            // Use the name set in Control Center, if there is one.
            request("GET", sender.name, path: "/elgato/accessory-info") { [weak self] obj in
                if let name = obj?["displayName"] as? String, !name.isEmpty { self?.lights[sender.name]?.name = name }
            }
        }
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        resolving.removeAll { $0 === sender }
    }

    /// "Elgato Key Light MK 2 1A2B" -> "Key Light 1A2B"
    private static func friendlyName(_ service: String) -> String {
        let suffix = service.split(separator: " ").last.map(String.init) ?? ""
        return service.contains("Key Light") ? "Key Light \(suffix)" : service
    }

    // MARK: HTTP

    private func request(_ method: String, _ id: String, path: String, body: [String: Any]? = nil,
                         done: @escaping ([String: Any]?) -> Void) {
        guard let light = lights[id], let url = URL(string: "http://\(light.host):\(light.port)\(path)") else { done(nil); return }
        var r = URLRequest(url: url)
        r.httpMethod = method
        if let body = body {
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        session.dataTask(with: r) { data, _, error in
            let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            if let error = error { Log.write("Elgato: \(method) \(id) failed: \(error.localizedDescription)") }
            DispatchQueue.main.async { done(obj) }
        }.resume()
    }

    /// Every known light with its current state. Calls back on the main thread.
    func list(_ done: @escaping ([[String: Any]]) -> Void) {
        start()
        let ids = lights.keys.sorted()
        guard !ids.isEmpty else { done([]); return }
        var results: [String: [String: Any]] = [:]
        let group = DispatchGroup()
        for id in ids {
            group.enter()
            request("GET", id, path: "/elgato/lights") { obj in
                var item: [String: Any] = ["id": id, "name": self.lights[id]?.name ?? id, "reachable": obj != nil]
                if let l = (obj?["lights"] as? [[String: Any]])?.first {
                    item["on"] = (l["on"] as? Int ?? 0) != 0
                    item["brightness"] = l["brightness"] as? Int ?? 0
                    item["temperature"] = l["temperature"] as? Int ?? 250
                }
                results[id] = item
                group.leave()
            }
        }
        group.notify(queue: .main) { done(ids.compactMap { results[$0] }) }
    }

    /// Sets on/brightness/temperature (any subset) on the given lights (empty = all).
    func set(ids: [String], on: Bool?, brightness: Int?, temperature: Int?, done: @escaping (Int) -> Void) {
        start()
        let targets = ids.isEmpty ? Array(lights.keys) : ids.filter { lights[$0] != nil }
        guard !targets.isEmpty else { done(0); return }
        var light: [String: Any] = [:]
        if let on = on { light["on"] = on ? 1 : 0 }
        if let b = brightness { light["brightness"] = max(3, min(100, b)) }
        if let t = temperature { light["temperature"] = max(143, min(344, t)) }
        let body: [String: Any] = ["numberOfLights": 1, "lights": [light]]
        var ok = 0
        let group = DispatchGroup()
        for id in targets {
            group.enter()
            request("PUT", id, path: "/elgato/lights", body: body) { obj in
                if obj != nil { ok += 1 }
                group.leave()
            }
        }
        group.notify(queue: .main) { done(ok) }
    }
}
