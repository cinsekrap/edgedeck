import Foundation
import CoreAudio

/// Audio device switching and microphone mute via CoreAudio. No permissions
/// needed: changing a device's mute or volume isn't the same as recording.
enum Audio {
    // MARK: Low-level helpers

    private static let system = AudioObjectID(kAudioObjectSystemObject)

    private static func address(_ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                                _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    }

    private static func get<T>(_ object: AudioObjectID, _ addr: AudioObjectPropertyAddress, _ initial: T) -> T? {
        var addr = addr
        guard AudioObjectHasProperty(object, &addr) else { return nil }
        var value = initial
        var size = UInt32(MemoryLayout<T>.size)
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0)
        }
        return status == noErr ? value : nil
    }

    @discardableResult
    private static func set<T>(_ object: AudioObjectID, _ addr: AudioObjectPropertyAddress, _ value: T) -> Bool {
        var addr = addr
        guard AudioObjectHasProperty(object, &addr) else { return false }
        var settable: DarwinBoolean = false
        guard AudioObjectIsPropertySettable(object, &addr, &settable) == noErr, settable.boolValue else { return false }
        var value = value
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectSetPropertyData(object, &addr, 0, nil, UInt32(MemoryLayout<T>.size), $0)
        }
        return status == noErr
    }

    private static func deviceIDs() -> [AudioDeviceID] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private static func name(of id: AudioDeviceID) -> String {
        var addr = address(kAudioObjectPropertyName)
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name) == noErr, let n = name else { return "Unknown" }
        return n.takeRetainedValue() as String
    }

    private static func hasStreams(_ id: AudioDeviceID, input: Bool) -> Bool {
        var addr = address(kAudioDevicePropertyStreams, input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput)
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr && size > 0
    }

    static func defaultDevice(input: Bool) -> AudioDeviceID {
        let sel = input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice
        return get(system, address(sel), AudioDeviceID(0)) ?? 0
    }

    // MARK: Public

    /// Everything the audio widget needs in one call.
    static func state() -> [String: Any] {
        let defIn = defaultDevice(input: true)
        let defOut = defaultDevice(input: false)
        var inputs: [[String: Any]] = []
        var outputs: [[String: Any]] = []
        for id in deviceIDs() {
            let n = name(of: id)
            if hasStreams(id, input: true) { inputs.append(["id": Int(id), "name": n, "default": id == defIn]) }
            if hasStreams(id, input: false) { outputs.append(["id": Int(id), "name": n, "default": id == defOut]) }
        }
        var result: [String: Any] = ["inputs": inputs, "outputs": outputs]
        if defIn != 0 {
            result["micName"] = name(of: defIn)
            if let m = micMuted() { result["micMuted"] = m }
        }
        return result
    }

    static func setDefault(_ id: Int, input: Bool) -> Bool {
        let sel = input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice
        guard id > 0, let device = AudioDeviceID(exactly: id) else { return false }
        return set(system, address(sel), device)
    }

    /// Elements to try for per-channel controls: main first, then channels 1 and 2.
    private static let elements: [AudioObjectPropertyElement] = [kAudioObjectPropertyElementMain, 1, 2]

    /// Volume to restore on unmute, per device, for mics without a mute control.
    private static var savedVolume: [AudioDeviceID: Float32] = [:]

    static func micMuted() -> Bool? {
        let dev = defaultDevice(input: true)
        guard dev != 0 else { return nil }
        for el in elements {
            if let m = get(dev, address(kAudioDevicePropertyMute, kAudioDevicePropertyScopeInput, el), UInt32(0)) {
                return m != 0
            }
        }
        for el in elements {
            if let v = get(dev, address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput, el), Float32(0)) {
                return v <= 0.001
            }
        }
        return nil
    }

    /// Mutes or unmutes the current input device. Uses the device's mute
    /// control when it has one, otherwise sets its input volume to zero and
    /// restores it afterwards. Returns the new state, or nil if neither works.
    static func setMicMuted(_ mute: Bool) -> Bool? {
        let dev = defaultDevice(input: true)
        guard dev != 0 else { return nil }

        var usedMute = false
        for el in elements where set(dev, address(kAudioDevicePropertyMute, kAudioDevicePropertyScopeInput, el), UInt32(mute ? 1 : 0)) {
            usedMute = true
        }
        if usedMute { return micMuted() }

        var usedVolume = false
        for el in elements {
            let addr = address(kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput, el)
            guard let current = get(dev, addr, Float32(0)) else { continue }
            if mute {
                if current > 0.001 { savedVolume[dev] = current }
                usedVolume = set(dev, addr, Float32(0)) || usedVolume
            } else {
                usedVolume = set(dev, addr, savedVolume[dev] ?? 0.75) || usedVolume
            }
        }
        return usedVolume ? micMuted() : nil
    }
}
