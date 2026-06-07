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
                PositionLinks(wallet: p.wallet, positionAddress: p.positionAddress, mint: p.tokenXMint)
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    Text("\(signed(p.pnlSol)) SOL")
                        .font(.system(size: 13, weight: .semibold).monospacedDigit())
                        .foregroundStyle(pnlColor(p.pnlPctSol))
                    Text(pct2(p.pnlPctSol))
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .foregroundStyle(pnlColor(p.pnlPctSol))
                }
            }
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Size \(abs3(p.sizeSol)) SOL · \(ageString(p.openedAt))")
                        .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                    Text("Fees \(feeStr(p)) (\(feeYield(p)))")
                        .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                }
                Spacer()
                RangeBar(position: p).frame(width: 96)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color.primary.opacity(hovering ? 0.08 : 0.05),
            in: RoundedRectangle(cornerRadius: 10),
        )
        .onHover { hovering = $0 }
    }
}
