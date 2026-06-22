import Foundation
import Observation

public enum ConnectionState: Sendable {
    case unconfigured // no auth password set yet
    case connecting
    case live
    case offline // can't reach the API
    case unauthorized // API rejected the credentials (WS 1008)
}

@Observable
@MainActor
public final class PortfolioStore {
    public var scope: String = "all"
    public var wallets: [WalletInfo] = []
    public var totals: PortfolioTotals?
    public var positions: [OpenPosition] = []
    public var closed: [ClosedPosition] = []
    public var closedTotal = 0
    public var stats: Stats?
    public var connection: ConnectionState = .connecting
    public var health: Health?
    public var lastTickAt: Date?

    public init() {}

    public func setHealth(_ h: Health) { health = h }

    public func apply(_ state: WalletState) {
        guard state.scope == scope else { return } // ignore other scopes' snapshots
        totals = state.totals
        positions = state.openPositions.sorted { $0.pnlSol > $1.pnlSol }
        lastTickAt = Date()
    }

    public func setConnection(_ c: ConnectionState) { connection = c }
}
