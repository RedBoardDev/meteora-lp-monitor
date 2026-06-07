import SwiftUI

public func pnlColor(_ pct: Double) -> Color { pct > 0.1 ? .green : pct < -0.1 ? .red : .primary }

func isOut(_ s: RangeStatus) -> Bool { s == .out_up || s == .out_down }
