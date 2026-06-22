import SwiftUI
import UniformTypeIdentifiers

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
        let color: Color = isOut(status) ? Theme.outRange : Theme.inRange
        return HStack(spacing: 2) {
            switch status {
            case .out_up:
                Text("OUT")
                Image(systemName: "arrow.up")
            case .out_down:
                Text("OUT")
                Image(systemName: "arrow.down")
            case .in:
                Text("IN")
            default:
                Image(systemName: "questionmark")
            }
        }
        // Prose status label (IN/OUT) stays on the system font — mono is reserved for data values.
        .font(.system(size: 10, weight: .semibold))
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: 5))
        .foregroundStyle(color)
    }
}

/// Compact, neutral chip for the position's DLMM strategy (Spot/Curve/BidAsk) — mirrors the web's
/// strategy badge. Deliberately uncoloured so it reads as a different facet than the range status.
public struct StrategyBadge: View {
    let family: StrategyFamily

    public init(family: StrategyFamily) { self.family = family }

    public var body: some View {
        Text(family.rawValue)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
            .foregroundStyle(.secondary)
    }
}

/// Cumulative fees earned by the position — claimed + unclaimed as a single SOL figure (no split,
/// no yield percent). Shared by the open-position card on both platforms.
public struct FeesLabel: View {
    let position: OpenPosition

    public init(position: OpenPosition) { self.position = position }

    public var body: some View {
        HStack(spacing: 5) {
            Text("Fees")
            Image(systemName: "centsign.circle")
            Text(abs3(position.claimedFeesSol + position.unclaimedFeesSol))
        }
        .font(.data(11))
        .foregroundStyle(.secondary)
    }
}

/// Two discreet quick-links per position: LPAgent portfolio + GMGN token chart.
/// Uses SwiftUI's openURL so it works on both macOS and iOS.
public struct PositionLinks: View {
    @Environment(\.openURL) private var openURL
    let wallet: String
    let positionAddress: String
    let mint: String
    /// When set (closed positions only), appends a share button that exports the PnL card PNG.
    let shareAddress: String?

    public init(wallet: String, positionAddress: String, mint: String, shareAddress: String? = nil) {
        self.wallet = wallet
        self.positionAddress = positionAddress
        self.mint = mint
        self.shareAddress = shareAddress
    }

    public var body: some View {
        HStack(spacing: 6) {
            link(
                "chart.bar.doc.horizontal",
                "https://app.lpagent.io/portfolio?address=\(wallet)&positionId=\(positionAddress)",
            )
            link("chart.line.uptrend.xyaxis", "https://gmgn.ai/sol/token/\(mint)")
            if let shareAddress {
                ShareLink(
                    item: PnlCardTransferable(address: shareAddress),
                    preview: SharePreview("PnL card")
                ) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: linkIconFont))
                        .foregroundStyle(.secondary)
                        .frame(width: linkButtonSize.width, height: linkButtonSize.height)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointingHandCursor()
            }
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
        .pointingHandCursor()
    }
}

/// A position's PnL share card, fetched from the backend on demand when the user invokes Share.
///
/// Modelling it as `Transferable` lets a single `ShareLink` drive the native share sheet on both
/// iOS and macOS: the (authenticated) PNG is generated lazily — only when the user actually shares —
/// which also sidesteps the macOS menu-bar popover dismissing while an imperative picker is shown.
struct PnlCardTransferable: Transferable {
    let address: String

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .png) { card in
            let enc =
                card.address.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
                ?? card.address
            guard let data = await Backend.fetchData("/positions/\(enc)/card.png") else {
                throw ShareCardError.unavailable
            }
            return data
        }
        .suggestedFileName("pnl-card.png")
    }
}

private enum ShareCardError: Error { case unavailable }
