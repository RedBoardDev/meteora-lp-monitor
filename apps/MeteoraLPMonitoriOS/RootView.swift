import MeteoraLPMonitorKit
import SwiftUI

struct RootView: View {
    @Environment(PortfolioStore.self) private var store
    let setScope: (String) -> Void
    let reconnect: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    scopeChips
                    if let hint = connectionHint(store.connection, apiURL: Config.apiURL) {
                        statusBanner(hint)
                    } else if let t = store.totals {
                        summary(t)
                    } else {
                        ProgressView("Connecting…")
                            .frame(maxWidth: .infinity).padding(.vertical, 40)
                    }
                    openSection
                    closedSection
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable {
                reconnect()
                try? await Task.sleep(for: .seconds(1))
            }
            .navigationTitle("Meteora LP Monitor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { connectionDot }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink { SettingsView(reconnect: reconnect) } label: {
                        Image(systemName: "gearshape").foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: Scope selector

    private var scopeChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("Overview", scope: "all")
                ForEach(store.wallets) { w in
                    chip(w.label.isEmpty ? short(w.address) : w.label, scope: w.address)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func chip(_ title: String, scope: String) -> some View {
        let active = store.scope == scope
        return Button { setScope(scope) } label: {
            Text(title)
                .font(.system(size: 15, weight: .medium))
                .padding(.horizontal, 16).padding(.vertical, 9)
                .background(active ? Color.accentColor.opacity(0.22) : Color.primary.opacity(0.06),
                            in: Capsule())
                .foregroundStyle(active ? Color.accentColor : .secondary)
        }
        .buttonStyle(.plain)
    }

    // MARK: Status banner (not connected)

    private func statusBanner(_ hint: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(hint).font(.system(size: 14)).foregroundStyle(.secondary)
            NavigationLink { SettingsView(reconnect: reconnect) } label: {
                Text("Open Settings").font(.system(size: 14, weight: .semibold))
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    // MARK: Summary

    private func summary(_ t: PortfolioTotals) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(signed(t.uPnlSol)) SOL")
                        .font(.system(size: 34, weight: .bold).monospacedDigit())
                        .foregroundStyle(pnlColor(t.uPnlPct))
                    Text(pct2(t.uPnlPct))
                        .font(.system(size: 16, weight: .semibold).monospacedDigit())
                        .foregroundStyle(pnlColor(t.uPnlPct))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("WALLET").font(.system(size: 11, weight: .semibold))
                        .tracking(0.5).foregroundStyle(.secondary)
                    Text("\(abs3(t.walletTotalSol)) SOL")
                        .font(.system(size: 18, weight: .semibold).monospacedDigit())
                }
            }
            Divider()
            HStack(alignment: .top, spacing: 0) {
                stat("Fees", "\(abs3(t.feesSol)) SOL", pctOf(t.claimedFeesSol + t.unclaimedFeesSol, t.tvlSol))
                stat("TVL", "\(abs3(t.tvlSol)) SOL")
                todayStat(t)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
    }

    private func stat(_ label: String, _ value: String, _ sub: String? = nil, _ valueColor: Color = .secondary)
        -> some View
    {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 12)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 15, weight: .semibold).monospacedDigit())
                .foregroundStyle(valueColor == .secondary ? .primary : valueColor)
            if let sub {
                Text(sub).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Realized PnL since local midnight, as % of wallet size (parity with the Mac app).
    private func todayStat(_ t: PortfolioTotals) -> some View {
        let today = store.stats?.todayPnlSol ?? 0
        let color: Color = today > 0.0001 ? .green : today < -0.0001 ? .red : .primary
        return VStack(alignment: .leading, spacing: 3) {
            Text("Today").font(.system(size: 12)).foregroundStyle(.secondary)
            Text("\(signed(today)) SOL").font(.system(size: 15, weight: .semibold).monospacedDigit())
                .foregroundStyle(color)
            Text("\(pctOf(today, t.walletTotalSol)) of wallet")
                .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Open positions

    private var openSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("OPEN POSITIONS", count: store.positions.count)
            if store.positions.isEmpty {
                emptyRow(store.wallets.isEmpty ? "Add a wallet in Settings to start" : "No open positions")
            } else {
                ForEach(store.positions) { p in PositionCard(p: p) }
            }
        }
    }

    // MARK: Closed history

    private var closedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                sectionLabel("CLOSED", count: store.closedTotal)
                Spacer()
                if let s = store.stats {
                    Text(signed(s.totalPnlSol)).font(.system(size: 13, weight: .medium).monospacedDigit())
                        .foregroundStyle(s.totalPnlSol >= 0 ? .green : .red)
                    Text("win \(Int(s.winRate))%").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
            if store.closed.isEmpty {
                emptyRow("No closed positions yet")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(store.closed.enumerated()), id: \.element.id) { idx, c in
                        if idx > 0 { Divider() }
                        closedRow(c)
                    }
                }
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private func closedRow(_ c: ClosedPosition) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(c.tokenX)/\(c.tokenY)").font(.system(size: 14, weight: .medium))
                    .lineLimit(1)
                Text("fees \(abs3(c.feesSol)) · \(ageString(c.closedAt))")
                    .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(signed(c.pnlSol))
                    .font(.system(size: 13, weight: .semibold).monospacedDigit())
                    .foregroundStyle(pnlColor(c.pnlPctSol))
                Text(pct2(c.pnlPctSol))
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(pnlColor(c.pnlPctSol))
            }
            PositionLinks(wallet: c.wallet, positionAddress: c.positionAddress, mint: c.tokenXMint)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
    }

    // MARK: Shared bits

    private func emptyRow(_ text: String) -> some View {
        Text(text).font(.system(size: 13)).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10)
    }

    private var connectionDot: some View {
        let degraded = store.health.map { !$0.wsConnected || !$0.meteoraOk } ?? false
        let color: Color = switch store.connection {
        case .live: degraded ? .orange : .green
        case .connecting: .orange
        case .offline, .unauthorized: .red
        case .unconfigured: .secondary
        }
        return Circle().fill(color).frame(width: 10, height: 10)
            .contentShape(Rectangle())
            .onTapGesture { reconnect() }
    }

    private func sectionLabel(_ title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 12, weight: .semibold)).tracking(0.4)
                .foregroundStyle(.secondary)
            Text("\(count)").font(.system(size: 12).monospacedDigit()).foregroundStyle(.tertiary)
        }
    }
}
