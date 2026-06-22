import UserNotifications
#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// Notification authorization helpers, cross-platform.
public enum NotifPermission {
    public static func status() async -> UNAuthorizationStatus {
        await withCheckedContinuation { cont in
            UNUserNotificationCenter.current().getNotificationSettings { s in
                cont.resume(returning: s.authorizationStatus)
            }
        }
    }

    /// Prompts the user (only effective while status is .notDetermined).
    @discardableResult
    public static func request() async -> Bool {
        let granted = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound, .badge])
        return granted ?? false
    }

    /// Opens the OS notification settings for this app (used when already denied).
    public static func openSystemSettings() {
        #if os(macOS)
            let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            if let url { NSWorkspace.shared.open(url) }
        #else
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        #endif
    }
}
