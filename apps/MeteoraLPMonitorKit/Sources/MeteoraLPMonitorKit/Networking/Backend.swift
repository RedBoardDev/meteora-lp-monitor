import Foundation

/// Result of a mutating API call, so the UI can show a precise error.
public enum APIOutcome: Sendable { case ok, unauthorized, failed }

public enum Backend {
    private static func request(_ path: String, method: String = "GET", body: Data? = nil)
        async -> URLRequest?
    {
        guard let url = URL(string: Config.apiURL + path) else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let token = await Auth.shared.token() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    static func get<T: Decodable>(_ path: String) async -> T? {
        // One retry: a 401 means the JWT expired — drop it and re-login via Auth, then try again.
        for attempt in 0..<2 {
            guard let req = await request(path) else { return nil }
            guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return nil }
            if (resp as? HTTPURLResponse)?.statusCode == 401, attempt == 0 {
                await Auth.shared.invalidate()
                continue
            }
            return try? JSONDecoder().decode(T.self, from: data)
        }
        return nil
    }

    /// Fetches raw bytes (e.g. a generated PNG share card) from an authenticated endpoint.
    /// One retry on a 401, mirroring `get`. Nil on any failure (offline, unauthorized, non-2xx).
    public static func fetchData(_ path: String) async -> Data? {
        for attempt in 0..<2 {
            guard let req = await request(path) else { return nil }
            guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return nil }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 401, attempt == 0 {
                await Auth.shared.invalidate()
                continue
            }
            return (200..<300).contains(code) ? data : nil
        }
        return nil
    }

    @discardableResult
    private static func send(_ path: String, method: String, body: Data? = nil) async -> APIOutcome {
        for attempt in 0..<2 {
            guard let req = await request(path, method: method, body: body) else { return .failed }
            guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return .failed }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 401 {
                if attempt == 0 {
                    await Auth.shared.invalidate()
                    continue
                }
                return .unauthorized
            }
            return (200..<300).contains(code) ? .ok : .failed
        }
        return .failed
    }

    public static func wallets() async -> [WalletInfo] { await get("/wallets") ?? [] }

    @discardableResult
    public static func addWallet(address: String, label: String) async -> APIOutcome {
        let body = try? JSONSerialization.data(withJSONObject: ["address": address, "label": label])
        return await send("/wallets", method: "POST", body: body)
    }

    @discardableResult
    public static func removeWallet(address: String) async -> APIOutcome {
        let enc = address.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? address
        return await send("/wallets/\(enc)", method: "DELETE")
    }

    public static func notifRules() async -> [NotifRule] { await get("/config/notifications") ?? [] }

    @discardableResult
    public static func saveNotifRule(_ r: NotifRule) async -> APIOutcome {
        // NSNull (not omission) so the zod `.nullable()` fields validate.
        let body: [String: Any] = [
            "wallet": r.wallet ?? NSNull(),
            "eventKind": r.eventKind,
            "enabled": r.enabled,
            "mode": r.mode,
            "threshold": r.threshold ?? NSNull(),
            "oorMinutes": r.oorMinutes ?? NSNull(),
        ]
        let data = try? JSONSerialization.data(withJSONObject: body)
        return await send("/config/notifications", method: "PUT", body: data)
    }
}
