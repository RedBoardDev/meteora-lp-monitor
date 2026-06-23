import Foundation

public final class RestClient {
    private let store: PortfolioStore

    public init(store: PortfolioStore) { self.store = store }

    public func refresh() {
        Task { await load() }
    }

    private func load() async {
        let scope = await store.scope
        async let pageT: ClosedPage? = Backend.get(
            "/positions/closed?wallet=\(scope)&page=1&pageSize=20")
        async let statsT: Stats? = Backend.get("/stats?wallet=\(scope)")
        async let walletsT: [WalletInfo]? = Backend.get("/wallets")
        let (page, stats, wallets) = await (pageT, statsT, walletsT)
        await MainActor.run {
            // A scope switch mid-flight must not get overwritten with the old scope's data: bail if the
            // store's scope changed while these three fetches were in flight.
            guard store.scope == scope else { return }
            if let page {
                store.closed = page.rows
                store.closedTotal = page.total
            }
            if let stats { store.stats = stats }
            if let wallets { store.wallets = wallets }
        }
    }
}
