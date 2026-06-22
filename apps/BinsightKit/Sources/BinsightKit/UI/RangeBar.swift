import SwiftUI

public struct RangeBar: View {
    let position: OpenPosition
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(position: OpenPosition) { self.position = position }

    private var progress: Double {
        switch position.rangeStatus {
        case .out_down: return 0
        case .out_up: return 1
        default:
            guard let price = position.poolPrice, position.maxPrice != position.minPrice else { return 0.5 }
            let lo = min(position.minPrice, position.maxPrice)
            let hi = max(position.minPrice, position.maxPrice)
            return min(1, max(0, (price - lo) / (hi - lo)))
        }
    }

    private var out: Bool { isOut(position.rangeStatus) }

    public var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill((out ? Theme.outRange : Theme.inRange).opacity(0.18))
                    .frame(height: 5)
                Circle()
                    .fill(out ? Theme.outRange : Theme.inRange)
                    .frame(width: 8, height: 8)
                    .position(x: geo.size.width * progress, y: geo.size.height / 2)
                    // Reduce-motion: snap instantly instead of springing the dot across the bar.
                    .animation(dataAnimation(reduceMotion), value: progress)
            }
        }
        .frame(height: 8)
    }
}
