import SwiftUI

// Quick-link button sizing: larger touch targets on iOS, compact on macOS (pointer).
#if os(iOS)
    private let linkButtonSize = CGSize(width: 34, height: 30)
    private let linkIconFont: CGFloat = 14
#else
    private let linkButtonSize = CGSize(width: 22, height: 20)
    private let linkIconFont: CGFloat = 11
#endif

public struct RangeBadge: View {
    let status: RangeStatus

    public init(status: RangeStatus) { self.status = status }

    public var body: some View {
        let label = switch status {
        case .out_up: "OUT ▲"
        case .out_down: "OUT ▼"
        case .in: "IN"
        default: "?"
        }
        let color: Color = isOut(status) ? .orange : .green
        return Text(label)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 5))
            .foregroundStyle(color)
    }
}

/// Two discreet quick-links per position: LPAgent portfolio + GMGN token chart.
/// Uses SwiftUI's openURL so it works on both macOS and iOS.
public struct PositionLinks: View {
    @Environment(\.openURL) private var openURL
    let wallet: String
    let positionAddress: String
    let mint: String

    public init(wallet: String, positionAddress: String, mint: String) {
        self.wallet = wallet
        self.positionAddress = positionAddress
        self.mint = mint
    }

    public var body: some View {
        HStack(spacing: 6) {
            link(
                "chart.bar.doc.horizontal",
                "https://app.lpagent.io/portfolio?address=\(wallet)&positionId=\(positionAddress)",
            )
            link("chart.line.uptrend.xyaxis", "https://gmgn.ai/sol/token/\(mint)")
        }
    }

    private func link(_ icon: String, _ url: String) -> some View {
        Button {
            if let u = URL(string: url) { openURL(u) }
        } label: {
            Image(systemName: icon)
                .font(.system(size: linkIconFont))
                .foregroundStyle(.secondary)
                .frame(width: linkButtonSize.width, height: linkButtonSize.height)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
