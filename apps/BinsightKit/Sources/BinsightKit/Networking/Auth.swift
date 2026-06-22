import Foundation

/// Wallet-address + password → JWT auth. The account identity is the Solana wallet address; both the
/// address and password are stored in the Keychain, and a short-lived JWT is fetched from `/auth/login`
/// and cached (refreshed before expiry, or after a 401). The REST + WS clients use the JWT as a Bearer
/// token / `?token=`. There is no static API token. Registration / password reset are web-only (they
/// need the wallet to sign) — the Apple apps only sign in.
public actor Auth {
    public static let shared = Auth()

    private struct LoginResponse: Decodable {
        let token: String
        let expiresInSeconds: Int
    }

    private var cachedToken: String?
    private var expiresAt: Date?

    /// A currently-valid JWT, refreshed from the stored password when needed. Nil if not logged in.
    public func token() async -> String? {
        if let t = cachedToken, let e = expiresAt, e > Date().addingTimeInterval(60) { return t }
        return await refresh()
    }

    /// Exchange an address + password for a JWT and persist both on success.
    @discardableResult
    public func login(address: String, password: String) async -> Bool {
        guard let res = await fetch(address: address, password: password) else { return false }
        Keychain.set("authAddress", address)
        Keychain.set("authPassword", password)
        apply(res)
        return true
    }

    /// Forget the credentials and any cached token.
    public func logout() {
        Keychain.set("authAddress", "")
        Keychain.set("authPassword", "")
        cachedToken = nil
        expiresAt = nil
    }

    /// Drop the cached token so the next `token()` re-logins (call after a 401).
    public func invalidate() {
        cachedToken = nil
        expiresAt = nil
    }

    private func refresh() async -> String? {
        guard let addr = Keychain.get("authAddress"), !addr.isEmpty,
            let pw = Keychain.get("authPassword"), !pw.isEmpty
        else { return nil }
        guard let res = await fetch(address: addr, password: pw) else { return nil }
        apply(res)
        return cachedToken
    }

    private func apply(_ res: LoginResponse) {
        cachedToken = res.token
        expiresAt = Date().addingTimeInterval(TimeInterval(res.expiresInSeconds))
    }

    private func fetch(address: String, password: String) async -> LoginResponse? {
        guard let url = URL(string: Config.apiURL + "/auth/login") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(
            withJSONObject: ["address": address, "password": password])
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
            (resp as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return try? JSONDecoder().decode(LoginResponse.self, from: data)
    }
}
