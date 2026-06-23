import Foundation
import UserNotifications

public final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = Notifier()
    override private init() { super.init() }

    /// Call once at launch. Registers the delegate so notifications show even when the app is
    /// active/foreground — the exact case where the backend routes to native instead of Bark.
    /// Does NOT request authorization: that prompt is owned by the user-initiated master toggle
    /// in `NotificationsEditor`, so we never ask twice.
    public static func bootstrap() {
        UNUserNotificationCenter.current().delegate = shared
    }

    public func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void,
    ) {
        completionHandler([.banner, .sound, .list])
    }

    public static func show(_ event: LiveEvent) {
        let content = UNMutableNotificationContent()
        content.title = event.title
        content.body = event.body
        content.threadIdentifier = event.pair ?? "portfolio"
        content.sound = .default
        let request = UNNotificationRequest(identifier: event.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            // Don't black-hole a failed alert (e.g. authorization revoked) — log it so a lost
            // notification is diagnosable rather than silently dropped.
            if let error {
                NSLog("[Notifier] failed to schedule notification: %@", error.localizedDescription)
            }
        }
    }
}
