import Foundation
import SwiftUI

public extension Font {
    /// Monospaced-digit data font (SF Mono, ships with the OS — zero project change).
    /// For numeric/tabular values so columns stay aligned as digits change.
    static func data(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced).monospacedDigit()
    }
}

public func signed(_ n: Double) -> String { (n >= 0 ? "+" : "") + String(format: "%.4f", n) }
public func abs4(_ n: Double) -> String { String(format: "%.4f", abs(n)) }
public func pct2(_ n: Double) -> String { String(format: "%+.2f%%", n) }
public func short(_ a: String) -> String { a.count > 8 ? "\(a.prefix(4))…\(a.suffix(4))" : a }

public func pctOf(_ part: Double, _ whole: Double) -> String {
    whole == 0 ? "—" : String(format: "%+.2f%%", part / whole * 100)
}

public func ageString(_ openedAt: Double?) -> String {
    guard let ms = openedAt, ms > 0 else { return "—" }
    let secs = max(0, Date().timeIntervalSince1970 - ms / 1000)
    if secs < 3600 { return "\(Int(secs / 60))m" }
    if secs < 86_400 { return "\(Int(secs / 3600))h" }
    return "\(Int(secs / 86_400))d"
}

/// How often a relative-age label re-evaluates. `ageString` is minute-grained, so a sub-minute tick
/// keeps it correct within seconds of each rollover without churning the view tree.
private let ageRefreshSeconds: TimeInterval = 30

/// Self-refreshing relative-age label. `ageString` reads the wall clock, but SwiftUI only re-renders
/// a view on state change — so a closed row (which gets no live WS frames) showed a frozen age until it
/// was hovered. Driving the label from a `TimelineView` ticks it every `ageRefreshSeconds` on its own.
public struct AgeText: View {
    private let timestampMs: Double?
    private let font: Font
    private let style: AnyShapeStyle

    // `some ShapeStyle` (not `Color`) so callers can pass hierarchical styles like `.tertiary`,
    // exactly as `.foregroundStyle(.tertiary)` does — `Color` exposes only `.primary`/`.secondary`.
    public init(
        _ timestampMs: Double?, font: Font = .data(11),
        color: some ShapeStyle = HierarchicalShapeStyle.secondary,
    ) {
        self.timestampMs = timestampMs
        self.font = font
        style = AnyShapeStyle(color)
    }

    public var body: some View {
        TimelineView(.periodic(from: Date(), by: ageRefreshSeconds)) { _ in
            Text(ageString(timestampMs)).font(font).foregroundStyle(style)
        }
    }
}
