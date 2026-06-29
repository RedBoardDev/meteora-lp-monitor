import Foundation

/// Client configuration (API endpoint). The API URL may be overridden in Settings or baked at
/// build time from the repo `.env` (Info.plist seed). Authentication is password→JWT (see `Auth`):
/// the password lives in the Keychain, never baked into the app.
/// P2: switch `defaults` to `UserDefaults(suiteName: appGroup)` once the App Group
/// entitlement is provisioned, so widgets/Live Activity read the same config.
public enum Config {
    public static let appGroup = "group.com.binsight"

    static var defaults: UserDefaults { .standard }

    /// Non-empty Info.plist string baked at build time (see the Makefile's MLPM_* settings).
    private static func seed(_ key: String) -> String? {
        guard let s = Bundle.main.object(forInfoDictionaryKey: key) as? String, !s.isEmpty else {
            return nil
        }
        return s
    }

    public static var apiURL: String {
        get { defaults.string(forKey: "apiURL") ?? seed("MLPMApiURL") ?? "http://localhost:8787" }
        set { defaults.set(newValue, forKey: "apiURL") }
    }

    /// Production web origin — the live public site the panel's "open in browser" quick-link targets.
    public static let prodWebURL = "https://binsight.thomasott.fr"

    /// The web app origin for deep-links, mirroring the configured API origin.
    public static var webURL: String { webURL(fromAPI: apiURL) }

    /// Pure derivation (testable): the web origin is the API origin minus the `api.` host prefix
    /// (api.binsight.thomasott.fr → binsight.thomasott.fr). Non-`api.` hosts (e.g. a localhost dev API)
    /// fall back to the production web origin, since the quick-link always points at the live app.
    static func webURL(fromAPI apiURL: String) -> String {
        if let u = URL(string: apiURL), let scheme = u.scheme, let host = u.host, host.hasPrefix("api.") {
            return "\(scheme)://\(host.dropFirst(4))"
        }
        return prodWebURL
    }

    /// Master switch: when off, the app shows no native notifications (default on).
    public static var notificationsEnabled: Bool {
        get { defaults.object(forKey: "notificationsEnabled") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "notificationsEnabled") }
    }

    /// Whether the app has the minimum config to connect (a saved wallet address + password).
    public static var isConfigured: Bool {
        !(Keychain.get("authAddress") ?? "").isEmpty && !(Keychain.get("authPassword") ?? "").isEmpty
    }
}

/// User-facing hint for a non-live connection state (nil when live/connecting normally).
public func connectionHint(_ state: ConnectionState, apiURL: String) -> String? {
    switch state {
    case .unconfigured: "Not signed in — open Settings to enter your wallet address + password."
    case .unauthorized: "Unauthorized — check your address and password in Settings."
    case .offline: "Can't reach the API at \(apiURL)."
    case .connecting, .live: nil
    }
}
