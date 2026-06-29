import SwiftUI

/// Open-position card for the macOS panel. Pair + range badge + quick-links,
/// PnL (SOL + %), size/age, fees, and the range bar.
public struct PositionCard: View {
    let p: OpenPosition
    @State private var hovering = false

    public init(p: OpenPosition) { self.p = p }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                // lineLimit(1): a long pair must truncate, never wrap to a second line (which would grow
                // the card's height). The PnL keeps priority so it's never the one compressed.
                Text("\(p.tokenX)/\(p.tokenY)")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                RangeBadge(status: p.rangeStatus)
                if let s = p.strategy { StrategyBadge(family: s) }
                // Collapsed to zero width until hovered, so the hidden quick-links don't permanently
                // steal horizontal space from the pair (which was truncating "BONK/USDC" → "BON…").
                PositionLinks(wallet: p.wallet, positionAddress: p.positionAddress, mint: p.tokenXMint)
                    .opacity(showLinks ? 1 : 0)
                    .frame(width: showLinks ? nil : 0)
                    .allowsHitTesting(showLinks)
                    .clipped()
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 0) {
                    Text("\(signed(p.pnlSol)) SOL")
                        .font(.data(13, weight: .semibold))
                        .foregroundStyle(pnlColor(p.pnlPctSol))
                    Text(pct2(p.pnlPctSol))
                        .font(.data(11, weight: .semibold))
                        .foregroundStyle(pnlColor(p.pnlPctSol))
                }
                .fixedSize()
                .layoutPriority(1)
            }
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    // Size + self-refreshing age on one bounded line (lineLimit(1) keeps the card height fixed).
                    HStack(spacing: 0) {
                        Text("Size \(abs4(p.sizeSol)) SOL · ")
                            .font(.data(11)).foregroundStyle(.secondary)
                        AgeText(p.openedAt)
                    }
                    .lineLimit(1)
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

    // Reveal the quick-links only while the row is hovered, to declutter the panel.
    private var showLinks: Bool { hovering }
}
