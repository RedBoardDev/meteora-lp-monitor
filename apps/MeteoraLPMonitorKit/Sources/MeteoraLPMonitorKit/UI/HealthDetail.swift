import SwiftUI

/// Colour for a per-source status string ("ok" | "lagging" | "down").
public func healthStatusColor(_ status: String) -> Color {
    switch status {
    case "ok": return Theme.profit
    case "lagging": return Theme.warn
    default: return Theme.loss
    }
}

/// Per-service live-status breakdown shown on hover (macOS) / tap (iOS) of the connection dot.
/// Renders every source the backend reports (rpc / meteora / jupiter / ws) with its
/// status, why it's degraded, and how long since it was last ok.
public struct HealthDetailView: View {
    let health: Health?
    public init(health: Health?) { self.health = health }

    public var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Live status").font(.system(size: 12, weight: .semibold))
            if let tip = health?.chainTipSlot {
                Text("chain slot \(tip)")
                    .font(.data(11)).foregroundStyle(.secondary)
            }
            let sources = health?.sources ?? []
            if sources.isEmpty {
                Text("No source data yet.").font(.system(size: 11)).foregroundStyle(.secondary)
            } else {
                ForEach(sources) { s in row(s) }
            }
        }
        .frame(minWidth: 230, alignment: .leading)
    }

    private func row(_ s: SourceHealth) -> some View {
        HStack(spacing: 7) {
            Circle().fill(healthStatusColor(s.status)).frame(width: 7, height: 7)
            Text(s.name).font(.system(size: 12, weight: .medium))
            Text(s.status).font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            if s.status != "ok", let d = s.detail {
                Text(d).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            } else if let ok = s.lastOkAt {
                Text(ageString(Double(ok))).font(.data(11)).foregroundStyle(.tertiary)
            }
        }
    }
}
