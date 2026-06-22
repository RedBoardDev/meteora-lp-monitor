import Foundation
import ServiceManagement

/// macOS-only launch-at-login toggle (SMAppService).
enum LaunchAtLogin {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("launch-at-login toggle failed: \(error)")
        }
    }
}
