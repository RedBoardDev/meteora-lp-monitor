import AppKit
import Foundation
import IOKit

/// Presence detection for macOS: "active" only when you're really at the Mac — awake,
/// screen unlocked, and not idle (no keyboard/mouse input) for more than `awaySeconds`.
/// Sleep/wake/lock/unlock flip immediately via `onChange`; idle is sampled by the heartbeat.
final class MacPresence {
    /// Called on awake/sleep/lock/unlock so the client can push a presence update immediately.
    var onChange: () -> Void = {}
    /// Called on wake-from-sleep so the client can drop the stale socket and reconnect.
    var onWake: () -> Void = {}

    private let awaySeconds: Double = 300 // 5 min without input → considered away
    private var awake = true
    private var locked = false

    init() {
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) {
            [weak self] _ in self?.update { $0.awake = false }
        }
        workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) {
            [weak self] _ in
            self?.update { $0.awake = true }
            self?.onWake()
        }
        let distributed = DistributedNotificationCenter.default()
        distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) {
            [weak self] _ in self?.update { $0.locked = true }
        }
        distributed.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) {
            [weak self] _ in self?.update { $0.locked = false }
        }
    }

    /// True when present at the Mac. Safe to read from any thread.
    var isActive: Bool {
        guard awake, !locked else { return false }
        return Self.idleSeconds() < awaySeconds
    }

    private func update(_ mutate: (MacPresence) -> Void) {
        mutate(self)
        onChange()
    }

    /// Seconds since the last HID (keyboard/mouse) input, via IORegistry.
    private static func idleSeconds() -> Double {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(
            kIOMainPortDefault, IOServiceMatching("IOHIDSystem"), &iterator,
        ) == KERN_SUCCESS else { return 0 }
        defer { IOObjectRelease(iterator) }
        let entry = IOIteratorNext(iterator)
        guard entry != 0 else { return 0 }
        defer { IOObjectRelease(entry) }

        var unmanaged: Unmanaged<CFMutableDictionary>?
        guard IORegistryEntryCreateCFProperties(entry, &unmanaged, kCFAllocatorDefault, 0)
            == KERN_SUCCESS,
            let props = unmanaged?.takeRetainedValue() as? [String: Any],
            let idleNs = (props["HIDIdleTime"] as? NSNumber)?.uint64Value
        else { return 0 }
        return Double(idleNs) / 1_000_000_000
    }
}
