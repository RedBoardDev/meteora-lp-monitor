import SwiftUI

/// Shared open-position card (macOS panel + iOS list). Pair + range badge + quick-links,
/// PnL (SOL + %), size/age, fees, and the range bar.
public struct PositionCard: View {
    let p: OpenPosition
    @State private var hovering = false

    public init(p: OpenPosition) { self.p = p }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Text("\(p.tokenX)/\(p.tokenY)").font(.system(size: 13, weight: .semibold))
                RangeBadge(status: p.rangeStatus)
                if let s = p.strategy { StrategyBadge(family: s) }
                // Always laid out (reserves space so the card never resizes); just faded in on hover.
                PositionLinks(wallet: p.wallet, positionAddress: p.positionAddress, mint: p.tokenXMint)
                    .opacity(showLinks ? 1 : 0)
                    .allowsHitTesting(showLinks)
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    Text("\(signed(p.pnlSol)) SOL")
                        .font(.data(13, weight: .semibold))
                        .foregroundStyle(pnlColor(p.pnlPctSol))
                    Text(pct2(p.pnlPctSol))
                        .font(.data(11, weight: .semibold))
                        .foregroundStyle(pnlColor(p.pnlPctSol))
                }
            }
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Size \(abs4(p.sizeSol)) SOL · \(ageString(p.openedAt))")
                        .font(.data(11)).foregroundStyle(.secondary)
                    FeesLabel(position: p)
                }
                Spacer()
                RangeBar(position: p).frame(width: 96)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .onHover { h in withAnimation(Theme.springPress) { hovering = h } }
    }

    // macOS: reveal the quick-links only while the row is hovered (declutter). iOS (touch) always shows.
    private var showLinks: Bool { hovering }
}
