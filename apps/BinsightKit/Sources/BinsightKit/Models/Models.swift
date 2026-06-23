import Foundation

// Wire types mirroring @binsight/shared. Only the fields the clients render.

public enum RangeStatus: String, Codable, Sendable { case `in`, out_up, out_down, unknown }

/// DLMM liquidity shape the position was opened with, resolved server-side from the open transaction.
/// Raw values match the wire enum (`@binsight/shared`). Nil until resolved (or if resolution failed).
public enum StrategyFamily: String, Codable, Sendable {
    case spot = "Spot"
    case curve = "Curve"
    case bidAsk = "BidAsk"
}

/// Client-side Solana address validation, mirrors the server's WalletSchema (base58, 32–44 chars;
/// rejects 0x/EVM & junk). A local guard so an obviously-malformed address never hits the network —
/// the backend re-validates.
public enum SolanaAddress {
    public static func isValid(_ s: String) -> Bool {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
            .range(of: "^[1-9A-HJ-NP-Za-km-z]{32,44}$", options: .regularExpression) != nil
    }
}

public struct PortfolioTotals: Codable, Sendable {
    public let uPnlSol: Double
    public let uPnlPct: Double
    public let feesSol: Double
    public let claimedFeesSol: Double
    public let unclaimedFeesSol: Double
    public let tvlSol: Double
    public let idleSol: Double
    public let walletTotalSol: Double
    public let openCount: Int
    public let inRangeCount: Int
    public let outOfRangeCount: Int
}

public struct OpenPosition: Codable, Identifiable, Sendable {
    public var id: String { positionAddress }
    public let positionAddress: String
    public let wallet: String
    public let tokenX: String
    public let tokenY: String
    public let tokenXMint: String
    public let sizeSol: Double
    public let pnlSol: Double
    public let pnlPctSol: Double
    public let claimedFeesSol: Double
    public let unclaimedFeesSol: Double
    public let rangeStatus: RangeStatus
    public let minPrice: Double
    public let maxPrice: Double
    public let poolPrice: Double?
    public let openedAt: Double?
    public let strategy: StrategyFamily?
}

public struct WalletState: Codable, Sendable {
    public let scope: String
    public let totals: PortfolioTotals
    public let openPositions: [OpenPosition]
}

public struct ClosedPosition: Codable, Identifiable, Sendable {
    public var id: String { positionAddress }
    public let positionAddress: String
    public let wallet: String
    public let tokenX: String
    public let tokenY: String
    public let tokenXMint: String
    public let pnlSol: Double
    public let pnlPctSol: Double
    public let feesSol: Double
    public let depositSol: Double
    public let closedAt: Double?
}

public struct ClosedPage: Codable, Sendable {
    public let rows: [ClosedPosition]
    public let total: Int
}

public struct WalletInfo: Codable, Identifiable, Sendable {
    public var id: String { address }
    public let address: String
    public let label: String
}

// Subset of the API /stats payload (extra keys are ignored by the decoder).
public struct Stats: Codable, Sendable {
    public let closedCount: Int
    public let winRate: Double
    public let totalPnlSol: Double
    public let todayPnlSol: Double
    public let totalFeesSol: Double
}

/// Engine health (subset). `wsConnected`/`meteoraOk` reflect the SERVER's data freshness —
/// distinct from the client's own socket, so the UI can warn when the engine is blind.
/// One external dependency's live status (rpc / meteora / jupiter / ws).
public struct SourceHealth: Codable, Sendable, Identifiable {
    public var id: String { name }
    public let name: String
    public let status: String          // "ok" | "lagging" | "down"
    public let lastOkAt: Int?
    public let lastErrorAt: Int?
    public let consecutiveErrors: Int
    public let detail: String?
}

public struct Health: Codable, Sendable {
    public let ok: Bool
    public let wsConnected: Bool
    public let meteoraOk: Bool
    // Added by the backend's per-source health system; optional so older payloads still decode.
    public let chainTipSlot: Int?
    public let sources: [SourceHealth]?
}

public struct LiveEvent: Codable, Sendable {
    public let id: String
    public let kind: String
    public let pair: String?
    public let title: String
    public let body: String
}

/// A notification rule (global when `wallet` is nil). Mirrors the API's NotifRule.
public struct NotifRule: Codable, Identifiable, Sendable {
    public var id: String { "\(wallet ?? "global"):\(eventKind)" }
    public let wallet: String?
    public let eventKind: String
    public var enabled: Bool
    public var mode: String
    public var threshold: Double?
    public var oorMinutes: Int?
}

// Tagged server messages (discriminated union by `type`).
enum ServerMessage: Decodable {
    case state(WalletState)
    case event(LiveEvent)
    case notify(LiveEvent)
    case health(Health)
    case closedChanged
    case other

    private static let decoder = JSONDecoder()

    /// Decode a raw WS frame in ONE pass (was: decode an Envelope for `type`, THEN re-decode the same
    /// bytes into PayloadWrapper<T> with a freshly-allocated JSONDecoder per call — twice per 1Hz frame).
    init(from data: Data) throws {
        self = try ServerMessage.decoder.decode(ServerMessage.self, from: data)
    }

    private enum CodingKeys: String, CodingKey { case type, payload }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "state": self = .state(try c.decode(WalletState.self, forKey: .payload))
        case "event": self = .event(try c.decode(LiveEvent.self, forKey: .payload))
        case "notify": self = .notify(try c.decode(LiveEvent.self, forKey: .payload))
        case "health": self = .health(try c.decode(Health.self, forKey: .payload))
        case "closed_changed": self = .closedChanged
        default: self = .other
        }
    }
}
