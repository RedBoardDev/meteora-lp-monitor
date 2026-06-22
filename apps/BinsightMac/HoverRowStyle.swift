import SwiftUI

/// Menu-row button style with a native hover/press highlight (plain buttons have none).
struct HoverRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration)
    }

    private struct Row: View {
        let configuration: Configuration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .background(
                    (hovering || configuration.isPressed ? Color.primary.opacity(0.09) : .clear),
                    in: RoundedRectangle(cornerRadius: 6),
                )
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}
