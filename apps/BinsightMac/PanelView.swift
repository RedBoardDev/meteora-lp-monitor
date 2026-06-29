import BinsightKit
import SwiftUI

/// How often the open panel re-renders so relative ages stay current. Ages tick in minutes, so a 30 s
/// cadence keeps them effectively fresh while the panel is open without re-rendering on every frame.
private let ageRefreshSeconds: TimeInterval = 30

struct PanelView: View {
    @Environment(PortfolioStore.self) private var store
    @Environment(\.openURL) private var openURL
    @State private var showHealthDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A single wallet makes "Overview" (the all-wallets aggregate) redundant — it equals that
            // wallet — so the whole scope bar is hidden until there are at least two wallets.
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
            HStack {
                Text("PORTFOLIO").font(.system(size: 11, weight: .semibold))
                    .tracking(0.6).foregroundStyle(.secondary)
                Spacer()
                openInBrowserButton
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

    // Open positions get their own bounded box so a long open list no longer pushes the closed history
    // far down a single shared scroll. Beyond `openScrollThreshold` cards the box switches from hugging
    // its content to a fixed, scrolling height (a pure count test — no layout measurement).
    private static let openScrollThreshold = 3 // above this many open cards, the box scrolls
    private static let openScrollCap: CGFloat = 320 // open box height once it scrolls (≈ threshold cards)
    private static let closedScrollHeight: CGFloat = 220 // closed-history box height (always scrolls)

    // MARK: Scrollable content (open + closed each in their own bounded scroll; labels/header/footer fixed)

    private var contentScroll: some View {
        // One timeline drives both lists so relative ages ("3m", "2h") stay fresh while the panel is open —
        // previously an age only updated when its row happened to re-render (hover).
        TimelineView(.periodic(from: .now, by: ageRefreshSeconds)) { ctx in
            VStack(alignment: .leading, spacing: 0) {
                openHeader // fixed: only the cards below scroll
                openScrollBox(now: ctx.date)
                Divider().padding(.horizontal, 10).padding(.top, 2)
                closedBar // fixed closed-history header
                ScrollView { closedList(now: ctx.date) }
                    .frame(height: Self.closedScrollHeight)
            }
        }
    }

    private var openHeader: some View {
        sectionLabel("OPEN POSITIONS", count: store.positions.count)
            .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 6)
    }

    /// Few open positions → the cards hug their content (no blank gap). Many → a fixed-height scroll so a
    /// long list can't push the closed history off-screen.
    @ViewBuilder private func openScrollBox(now: Date) -> some View {
        if store.positions.count > Self.openScrollThreshold {
            ScrollView { openCards(now: now) }.frame(height: Self.openScrollCap)
        } else {
            openCards(now: now)
        }
    }

    private func openCards(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if store.positions.isEmpty {
                Text(store.wallets.isEmpty ? "Add a wallet in Settings to start" : "No open positions")
                    .font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 6)
            } else {
                ForEach(store.positions) { p in PositionCard(p: p, now: now) }
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

    private func closedList(now: Date) -> some View {
        VStack(spacing: 0) {
            if store.closed.isEmpty {
                Text("No closed positions yet").font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            } else {
                ForEach(store.closed) { c in ClosedRow(c: c, now: now) }
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

    // Discreet quick-link: open the public web app on whatever the panel is currently viewing.
    private var openInBrowserButton: some View {
        Button {
            if let url = webDeepLink { openURL(url) }
        } label: {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable().frame(width: 14, height: 14).opacity(0.75)
        }
        .buttonStyle(.plain)
        .help("Open in Binsight")
        .pointingHandCursor()
    }

    // Mirror the panel's scope: overview → site root, a selected wallet → ?address=<wallet>.
    private var webDeepLink: URL? {
        let base = Config.webURL
        return URL(string: store.scope == "all" ? base : "\(base)/?address=\(store.scope)")
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
    let now: Date
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Text("\(c.tokenX)/\(c.tokenY)")
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
            Spacer()
            // Hover reveals the quick-links; at rest the same slot shows a discreet size + strategy
            // summary. Both are always laid out (ZStack) so the row never resizes between states.
            ZStack(alignment: .trailing) {
                PositionLinks(
                    wallet: c.wallet, positionAddress: c.positionAddress, mint: c.tokenXMint,
                    shareAddress: c.positionAddress)
                    .opacity(hovering ? 1 : 0)
                    .allowsHitTesting(hovering)
                restingSummary
                    .opacity(hovering ? 0 : 1)
                    .allowsHitTesting(false)
            }
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
            Text(ageString(c.closedAt, now: now))
                .font(.data(11))
                .foregroundStyle(.tertiary)
                .fixedSize()
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .onHover { h in withAnimation(Theme.springPress) { hovering = h } }
    }

    // Size (deposited SOL, 2 dp) + strategy family — shown only while the row is at rest.
    private var restingSummary: some View {
        HStack(spacing: 4) {
            Text("\(abs2(c.depositSol)) SOL")
            if let s = c.strategy { Text("· \(strategyShort(s))") }
        }
        .font(.data(11))
        .foregroundStyle(.tertiary)
        .fixedSize()
    }

    private func strategyShort(_ s: StrategyFamily) -> String {
        switch s {
        case .spot: "Spot"
        case .bidAsk: "Bid-Ask"
        case .curve: "Curve"
        }
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
