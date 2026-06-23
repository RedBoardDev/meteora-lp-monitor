import Foundation

/// Cross-target NotificationCenter names, shared so every target references the same
/// constants instead of redeclaring them.
public extension Notification.Name {
    /// Drop the socket and reconnect (e.g. after Settings saved a new URL/password or a wallet).
    static let reconnect = Notification.Name("BinsightReconnect")
    /// REST refresh now, keeping the socket streaming.
    static let refresh = Notification.Name("BinsightRefresh")
    /// Switch the active wallet scope; the posted object is the scope `String`.
    static let setScope = Notification.Name("BinsightSetScope")
    /// Posted when the local "Enable notifications" master toggle changes, so the host app can
    /// push a fresh presence heartbeat immediately (muting a device must route to Bark at once,
    /// not after the next 10s heartbeat).
    static let presenceShouldRefresh = Notification.Name("BinsightPresenceShouldRefresh")
}
