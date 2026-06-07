import MeteoraLPMonitorKit
import SwiftUI

struct PanelView: View {
    @Environment(PortfolioStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            tabs
            Divider()
            header
            Divider()
            contentScroll
            Divider()
            footer
        }
        .frame(width: 360)
        .background(.regularMaterial)
    }

    // MARK: Tabs (Overview + one per wallet)

    private var tabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                tab("Overview", scope: "all")
                ForEach(store.wallets) { w in
                    tab(w.label.isEmpty ? short(w.address) : w.label, scope: w.address)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
    }

    private func tab(_ title: String, scope: String) -> some View {
        let active = store.scope == scope
        return Button {
            NotificationCenter.default.post(name: .setScope, object: scope)
        } label: {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(active ? Color.accentColor.opacity(0.22) : .clear, in: Capsule())
                .foregroundStyle(active ? Color.accentColor : .secondary)
        }
        .buttonStyle(.plain)
    }

    // MARK: Header (portfolio totals)

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("PORTFOLIO").font(.system(size: 11, weight: .semibold))
                    .tracking(0.6).foregroundStyle(.secondary)
                Spacer()
                connectionDot
            }
            if let hint = connectionHint(store.connection, apiURL: Config.apiURL) {
                Text(hint).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Open Settings below to fix this.").font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            } else if let t = store.totals {
                heroRow(t)
                Divider()
                statStrip(t)
            } else {
                Text("Connecting…").font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(16)
    }

    private func heroRow(_ t: PortfolioTotals) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(signed(t.uPnlSol)) SOL")
                    .font(.system(size: 28, weight: .semibold).monospacedDigit())
                    .foregroundStyle(pnlColor(t.uPnlPct))
                Text(pct2(t.uPnlPct))
                    .font(.system(size: 15, weight: .semibold).monospacedDigit())
                    .foregroundStyle(pnlColor(t.uPnlPct))
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("WALLET").font(.system(size: 10, weight: .semibold))
                    .tracking(0.5).foregroundStyle(.secondary)
                Text("\(abs3(t.walletTotalSol)) SOL")
                    .font(.system(size: 15, weight: .semibold).monospacedDigit())
            }
        }
    }

    private func statStrip(_ t: PortfolioTotals) -> some View {
        HStack(alignment: .top, spacing: 0) {
            statCol("Fees", value: "\(abs3(t.feesSol)) SOL") {
                Text(pctOf(t.claimedFeesSol + t.unclaimedFeesSol, t.tvlSol))
                    .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
            }
            statCol("TVL", value: "\(abs3(t.tvlSol)) SOL") {
                EmptyView()
            }
            todayCol
        }
    }

    /// Realized PnL since local midnight (updates on close, via /stats), as % of wallet size.
    private var todayCol: some View {
        let today = store.stats?.todayPnlSol ?? 0
        let wallet = store.totals?.walletTotalSol ?? 0
        let color: Color = today > 0.0001 ? .green : today < -0.0001 ? .red : .primary
        return VStack(alignment: .leading, spacing: 2) {
            Text("Today").font(.system(size: 11)).foregroundStyle(.secondary)
            Text("\(signed(today)) SOL")
                .font(.system(size: 13, weight: .semibold).monospacedDigit())
                .foregroundStyle(color)
            Text("\(pctOf(today, wallet)) of wallet")
                .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statCol(
        _ label: String, value: String, @ViewBuilder sub: () -> some View,
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 13, weight: .semibold).monospacedDigit())
            sub()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Scrollable content (open + closed in one bounded scroll; header/footer stay fixed)

    private var contentScroll: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                openList
                Divider().padding(.horizontal, 10).padding(.top, 2)
                closedBar
                closedList
            }
        }
        .frame(height: 380)
    }

    private var openList: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("OPEN POSITIONS", count: store.positions.count)
            if store.positions.isEmpty {
                Text(store.wallets.isEmpty ? "Add a wallet in Settings to start" : "No open positions")
                    .font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 6)
            } else {
                ForEach(store.positions) { p in PositionCard(p: p) }
            }
        }
        .padding(10)
    }

    // MARK: Closed history (scrolls independently)

    private var closedBar: some View {
        HStack(spacing: 8) {
            Text("CLOSED\(store.closedTotal > 0 ? " (\(store.closedTotal))" : "")")
                .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            if let s = store.stats {
                Text(signed(s.totalPnlSol)).font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(s.totalPnlSol >= 0 ? .green : .red)
                Text("· win \(Int(s.winRate))%").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    private var closedList: some View {
        VStack(spacing: 0) {
            if store.closed.isEmpty {
                Text("No closed positions yet").font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                ForEach(store.closed) { c in closedRow(c) }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private func closedRow(_ c: ClosedPosition) -> some View {
        HStack(spacing: 8) {
            Text("\(c.tokenX)/\(c.tokenY)")
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
            Spacer()
            Text(signed(c.pnlSol))
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .foregroundStyle(pnlColor(c.pnlPctSol))
            HStack(spacing: 3) {
                Image(systemName: "centsign.circle")
                Text(abs3(c.feesSol))
            }
            .font(.system(size: 11).monospacedDigit())
            .foregroundStyle(.secondary)
            .fixedSize()
            Text(ageString(c.closedAt))
                .font(.system(size: 11).monospacedDigit())
                .foregroundStyle(.tertiary)
                .fixedSize()
            PositionLinks(wallet: c.wallet, positionAddress: c.positionAddress, mint: c.tokenXMint)
        }
        .padding(.vertical, 3)
    }

    // MARK: Footer (icon menu rows)

    private var footer: some View {
        VStack(spacing: 2) {
            SettingsLink { menuLabel("gearshape", "Settings") }
                .buttonStyle(HoverRowStyle())
            Button { NSApplication.shared.terminate(nil) } label: {
                menuLabel("power", "Quit")
            }
            .buttonStyle(HoverRowStyle())
        }
        .padding(6)
    }

    private func menuLabel(_ icon: String, _ label: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).frame(width: 18).foregroundStyle(.secondary)
            Text(label).font(.system(size: 13))
            Spacer()
        }
        .contentShape(Rectangle())
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    // MARK: Shared bits

    private var connectionDot: some View {
        let degraded = store.health.map { !$0.wsConnected || !$0.meteoraOk } ?? false
        let (color, label): (Color, String) = switch store.connection {
        case .live: degraded ? (.orange, "degraded") : (.green, "live")
        case .connecting: (.orange, "connecting")
        case .offline: (.red, "offline")
        case .unauthorized: (.red, "unauthorized")
        case .unconfigured: (.secondary, "setup")
        }
        return HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .onTapGesture { NotificationCenter.default.post(name: .reconnect, object: nil) }
    }

    private func sectionLabel(_ title: String, count: Int) -> some View {
        HStack {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            Spacer()
            Text("\(count)").font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
        }
    }
}
