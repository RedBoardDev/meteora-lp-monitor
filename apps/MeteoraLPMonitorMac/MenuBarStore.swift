import MeteoraLPMonitorKit
import SwiftUI

extension PortfolioStore {
    var menuBarText: String {
        if connection == .unconfigured { return "Setup" }
        guard let t = totals else { return "—" }
        // macOS renders the menu-bar label as a monochrome template (foregroundStyle is ignored),
        // so the +/- sign — not colour — carries gain vs loss here.
        let sign = t.uPnlSol >= 0 ? "+" : ""
        return "\(sign)\(String(format: "%.3f", t.uPnlSol)) · \(t.openCount)"
    }

    var menuBarColor: Color {
        guard let t = totals else { return .secondary }
        if t.uPnlPct > 0.1 { return .green }
        if t.uPnlPct < -0.1 { return .red }
        return .primary
    }

    // Connected with nothing open → show a playful glyph instead of "0.000 · 0".
    static let idleSymbol = "moon.zzz.fill"

    var menuBarIsIdle: Bool {
        connection == .live && (totals?.openCount ?? 0) == 0
    }
}
