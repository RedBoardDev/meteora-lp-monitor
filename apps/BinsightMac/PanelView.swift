import BinsightKit
import SwiftUI

struct PanelView: View {
    @Environment(PortfolioStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var showHealthDetail = false

    // Open positions get their own bounded box so a long open list no longer pushes the closed history
    // far down a single shared scroll. Beyond `openScrollThreshold` cards the box switches from hugging
    // its content to a fixed, scrolling height. The switch is a pure count test, NOT a layout
    // measurement: measuring a scroll whose own height feeds that measurement deadlocked to an empty box.
    private static let openScrollThreshold = 3 // above this many open cards, the box scrolls
    private static let openScrollCap: CGFloat = 320 // open box height once it scrolls (≈ threshold cards)
    private static let closedScrollHeight: CGFloat = 220 // closed-history box height (always scrolls)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A single wallet makes "Overview" (the all-wallets aggregate) redundant — it equals that
            // wallet — so the whole scope bar is hidden until there are at least two wallets to switch between.
            if store.wallets.count > 1 {
                tabs
                Divider()
            }
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
        TabChip(title: title, active: store.scope == scope) {
            NotificationCenter.default.post(name: .setScope, object: scope)
        }
    }

    // MARK: Header (portfolio totals)

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text("PORTFOLIO").font(.system(size: 11, weight: .semibold))
                    .tracking(0.6).foregroundStyle(.secondary)
                Spacer()
                openSiteButton
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
                    .font(.data(28, weight: .semibold))
                    .foregroundStyle(pnlColor(t.uPnlPct))
                Text(pct2(t.uPnlPct))
                    .font(.data(15, weight: .semibold))
                    .foregroundStyle(pnlColor(t.uPnlPct))
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("WALLET").font(.system(size: 10, weight: .semibold))
                    .tracking(0.5).foregroundStyle(.secondary)
                Text("\(abs4(t.walletTotalSol)) SOL")
                    .font(.data(15, weight: .semibold))
            }
        }
    }

    private func statStrip(_ t: PortfolioTotals) -> some View {
        HStack(alignment: .top, spacing: 0) {
            statCol("Fees", value: "\(abs4(t.feesSol)) SOL") {
                Text(pctOf(t.claimedFeesSol + t.unclaimedFeesSol, t.tvlSol))
                    .font(.data(11)).foregroundStyle(.secondary)
            }
            statCol("TVL", value: "\(abs4(t.tvlSol)) SOL") {
                EmptyView()
            }
            todayCol
        }
    }

    /// Realized PnL since local midnight (updates on close, via /stats), as % of wallet size.
    private var todayCol: some View {
        let today = store.stats?.todayPnlSol ?? 0
        let wallet = store.totals?.walletTotalSol ?? 0
        let color = pnlTone(value: today, basis: 0)
        return VStack(alignment: .leading, spacing: 2) {
            Text("Today").font(.system(size: 11)).foregroundStyle(.secondary)
            Text("\(signed(today)) SOL")
                .font(.data(13, weight: .semibold))
                .foregroundStyle(color)
            Text("\(pctOf(today, wallet)) of wallet")
                .font(.data(11)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func statCol(
        _ label: String, value: String, @ViewBuilder sub: () -> some View,
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(value).font(.data(13, weight: .semibold))
            sub()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Scrollable content (open + closed each in their own bounded scroll; labels/header/footer fixed)

    private var contentScroll: some View {
        VStack(alignment: .leading, spacing: 0) {
            openHeader // fixed: only the cards below scroll
            openScrollBox
            Divider().padding(.horizontal, 10).padding(.top, 2)
            closedBar // fixed closed-history header
            ScrollView { closedList }
                .frame(height: Self.closedScrollHeight)
        }
    }

    private var openHeader: some View {
        sectionLabel("OPEN POSITIONS", count: store.positions.count)
            .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 6)
    }

    /// Few open positions → the cards hug their content (no blank gap). Many → a fixed-height scroll so a
    /// long list can't push the closed history off-screen.
    @ViewBuilder private var openScrollBox: some View {
        if store.positions.count > Self.openScrollThreshold {
            ScrollView { openCards }.frame(height: Self.openScrollCap)
        } else {
            openCards
        }
    }

    private var openCards: some View {
        VStack(alignment: .leading, spacing: 6) {
            if store.positions.isEmpty {
                Text(store.wallets.isEmpty ? "Add a wallet in Settings to start" : "No open positions")
                    .font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 6)
            } else {
                ForEach(store.positions) { p in PositionCard(p: p) }
            }
        }
        .padding(.horizontal, 10).padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Closed history (scrolls independently)

    private var closedBar: some View {
        HStack(spacing: 8) {
            Text("CLOSED\(store.closedTotal > 0 ? " (\(store.closedTotal))" : "")")
                .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            if let s = store.stats {
                Text(signed(s.totalPnlSol)).font(.data(11))
                    .foregroundStyle(s.totalPnlSol >= 0 ? Theme.profit : Theme.loss)
                Text("· win \(Int(s.winRate))%").font(.data(11)).foregroundStyle(.secondary)
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
                ForEach(store.closed) { c in ClosedRow(c: c) }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
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

    /// Opens the current scope on the Binsight web app: Overview → the site root, a selected wallet →
    /// its `?address=` deep link.
    private var openSiteButton: some View {
        Button {
            if let url = siteURL { openURL(url) }
        } label: {
            Image(systemName: "arrow.up.right.square")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointingHandCursor()
        .help(store.scope == "all" ? "Open Binsight on the web" : "Open this wallet on Binsight web")
    }

    private var siteURL: URL? {
        guard store.scope != "all" else { return URL(string: Config.webURL) }
        let addr = store.scope.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? store.scope
        return URL(string: "\(Config.webURL)/?address=\(addr)")
    }

    private var connectionDot: some View {
        let degraded = store.health.map { !$0.wsConnected || !$0.meteoraOk } ?? false
        let color = connectionColor(store.connection, degraded: degraded)
        let label: String = switch store.connection {
        case .live: degraded ? "degraded" : "live"
        case .connecting: "connecting"
        case .offline: "offline"
        case .unauthorized: "unauthorized"
        case .unconfigured: "setup"
        }
        return HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        // Tap opens the health popover with an explicit Reconnect button (parity with iOS) — a bare
        // tap no longer reconnects accidentally.
        .onTapGesture { showHealthDetail = true }
        .pointingHandCursor()
        .popover(isPresented: $showHealthDetail, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 12) {
                HealthDetailView(health: store.health)
                Button("Reconnect") {
                    showHealthDetail = false
                    NotificationCenter.default.post(name: .reconnect, object: nil)
                }
                .font(.system(size: 12, weight: .medium))
            }
            .padding(12)
        }
    }

    private func sectionLabel(_ title: String, count: Int) -> some View {
        HStack {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            Spacer()
            Text("\(count)").font(.data(11)).foregroundStyle(.secondary)
        }
    }
}

/// A closed-position row: pair on the left, stats on the right. The quick-links (LPAgent / GMGN /
/// share) stay hidden until the row is hovered — appearing beside the stats — to keep the list clean.
private struct ClosedRow: View {
    let c: ClosedPosition
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Text("\(c.tokenX)/\(c.tokenY)")
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
            Spacer()
            // Always laid out (reserves width + height so the row never resizes); just faded in on hover.
            PositionLinks(
                wallet: c.wallet, positionAddress: c.positionAddress, mint: c.tokenXMint,
                shareAddress: c.positionAddress)
                .opacity(hovering ? 1 : 0)
                .allowsHitTesting(hovering)
            Text(signed(c.pnlSol))
                .font(.data(12, weight: .semibold))
                .foregroundStyle(pnlColor(c.pnlPctSol))
            HStack(spacing: 3) {
                Image(systemName: "centsign.circle")
                Text(abs4(c.feesSol))
            }
            .font(.data(11))
            .foregroundStyle(.secondary)
            .fixedSize()
            AgeText(c.closedAt, color: .tertiary)
                .fixedSize()
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onHover { h in withAnimation(Theme.springPress) { hovering = h } }
    }
}

/// Scope tab with a hover affordance (subtle bg on the inactive tab) + pointing-hand cursor.
private struct TabChip: View {
    let title: String
    let active: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(background, in: Capsule())
                .foregroundStyle(active ? Theme.accent : .secondary)
        }
        .buttonStyle(.plain)
        .onHover { h in
            hovering = h
            if h { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    private var background: Color {
        if active { return Theme.accent.opacity(0.22) }
        return hovering ? Color.primary.opacity(0.07) : .clear
    }
}
