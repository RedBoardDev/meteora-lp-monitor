import SwiftUI

public struct RangeBar: View {
    let position: OpenPosition

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
                    .fill((out ? Color.orange : Color.green).opacity(0.18))
                    .frame(height: 5)
                Circle()
                    .fill(out ? Color.orange : Color.green)
                    .frame(width: 8, height: 8)
                    .position(x: geo.size.width * progress, y: geo.size.height / 2)
                    .animation(.spring(duration: 0.35), value: progress)
            }
        }
        .frame(height: 8)
    }
}
