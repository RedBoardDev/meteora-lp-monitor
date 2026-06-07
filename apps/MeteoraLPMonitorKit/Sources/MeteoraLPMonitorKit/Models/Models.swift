import Foundation

// Wire types mirroring @meteora/shared. Only the fields the clients render.

public enum RangeStatus: String, Codable, Sendable { case `in`, out_up, out_down, unknown }

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
public struct Health: Codable, Sendable {
    public let ok: Bool
    public let wsConnected: Bool
    public let meteoraOk: Bool
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
enum ServerMessage {
    case state(WalletState)
    case event(LiveEvent)
    case notify(LiveEvent)
    case health(Health)
    case closedChanged
    case other

    init(from data: Data) throws {
        let env = try JSONDecoder().decode(Envelope.self, from: data)
        switch env.type {
        case "state": self = .state(try env.decodePayload(WalletState.self, data))
        case "event": self = .event(try env.decodePayload(LiveEvent.self, data))
        case "notify": self = .notify(try env.decodePayload(LiveEvent.self, data))
        case "health": self = .health(try env.decodePayload(Health.self, data))
        case "closed_changed": self = .closedChanged
        default: self = .other
        }
    }

    private struct Envelope: Decodable {
        let type: String
        func decodePayload<T: Decodable>(_: T.Type, _ data: Data) throws -> T {
            try JSONDecoder().decode(PayloadWrapper<T>.self, from: data).payload
        }
    }
    private struct PayloadWrapper<T: Decodable>: Decodable { let payload: T }
}
