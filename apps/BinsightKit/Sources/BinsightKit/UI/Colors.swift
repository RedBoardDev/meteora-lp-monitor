import SwiftUI
#if os(macOS)
    import AppKit
#endif

/// Brand palette, mapped from the web design tokens (web/src/app/globals.css) so all three
/// clients share one premium-dark identity instead of leaning on system .green/.red/.accentColor.
public enum Theme {
    // Semantic
    public static let profit = Color(hex: 0x3DDC8D)
    public static let loss = Color(hex: 0xFB7185)
    public static let warn = Color(hex: 0xF5B948)
    public static let accent = Color(hex: 0x3DDC8D)
    public static let inRange = Color(hex: 0x3DDC8D)
    public static let outRange = Color(hex: 0xF5B948)

    // Surfaces / chrome greys
    public static let surface = Color(hex: 0x141927)
    public static let surface2 = Color(hex: 0x1B2233)
    public static let border = Color.white.opacity(0.08)

    // Depth accent: a faint top-edge highlight.
    public static let topHighlight = Color.white.opacity(0.06)

    // Motion tokens — one entrance curve + one press spring, shared by all clients.
    public static let entrance = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.22)
    public static let springPress = Animation.spring(response: 0.3, dampingFraction: 0.8)
}

/// Corner-radius scale for the cinematic-terminal surfaces.
public enum Radius {
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1,
        )
    }
}

/// PnL tone for a SOL value, gated by its percent basis. Neutral when the move is tiny in BOTH
/// dimensions (|pct| ≤ 0.1% and |value| ≤ 0.0001 SOL) so dust doesn't flash green/red.
public func pnlTone(value: Double, basis pct: Double) -> Color {
    if pct > 0.1 || value > 0.0001 { return Theme.profit }
    if pct < -0.1 || value < -0.0001 { return Theme.loss }
    return .primary
}

/// Convenience for percent-only callers (PnL % already carries the sign/magnitude).
public func pnlColor(_ pct: Double) -> Color { pnlTone(value: 0, basis: pct) }

/// Dot/label colour for a connection state, optionally flagged degraded (live but a source is down).
public func connectionColor(_ state: ConnectionState, degraded: Bool = false) -> Color {
    switch state {
    case .live: return degraded ? Theme.warn : Theme.profit
    case .connecting: return Theme.warn
    case .offline, .unauthorized: return Theme.loss
    case .unconfigured: return .secondary
    }
}

func isOut(_ s: RangeStatus) -> Bool { s == .out_up || s == .out_down }

public extension View {
    /// macOS: show the pointing-hand cursor while hovering a clickable control. No-op on iOS.
    func pointingHandCursor() -> some View {
        #if os(macOS)
            return onHover { hovering in
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
        #else
            return self
        #endif
    }

    /// Shared data-update animation: snap instantly under reduce-motion, else the entrance curve.
    /// Generalizes the inline reduce-motion pattern RangeBar used.
    func dataAnimation(_ reduceMotion: Bool) -> Animation {
        reduceMotion ? .linear(duration: 0.01) : Theme.entrance
    }

    /// Material-free card surface: solid fill + clipped continuous corners + 1px hairline stroke +
    /// a faint top-edge highlight. Depth from material, not glassmorphism.
    func cardSurface(radius: CGFloat = Radius.md, elevated: Bool = false) -> some View {
        modifier(CardSurface(radius: radius, elevated: elevated))
    }
}

/// Reusable cinematic-terminal card chrome. See `View.cardSurface(radius:elevated:)`.
public struct CardSurface: ViewModifier {
    let radius: CGFloat
    let elevated: Bool

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return content
            .background(fill)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Theme.border, lineWidth: 1))
            .overlay(
                LinearGradient(
                    colors: [Theme.topHighlight, .clear],
                    startPoint: .top,
                    endPoint: .bottom,
                )
                .frame(height: 1.5)
                .frame(maxHeight: .infinity, alignment: .top)
                .clipShape(shape)
                .allowsHitTesting(false),
            )
    }

    /// Card fill. macOS: a faint light lift over the panel's translucent material so the card reads
    /// as a *raised* surface (like iOS cards do over the near-black system background) instead of an
    /// opaque dark patch. iOS: the solid brand surface on the near-black system background.
    private var fill: Color {
        #if os(macOS)
            return Color.white.opacity(elevated ? 0.10 : 0.07)
        #else
            return elevated ? Theme.surface2 : Theme.surface
        #endif
    }
}
