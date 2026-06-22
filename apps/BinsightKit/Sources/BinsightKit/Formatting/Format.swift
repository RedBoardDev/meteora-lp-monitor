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
public func abs3(_ n: Double) -> String { String(format: "%.4f", abs(n)) }
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
