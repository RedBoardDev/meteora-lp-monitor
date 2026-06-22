import BinsightKit
import SwiftUI

struct SettingsView: View {
    let reconnect: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            ConnectionSettingsSection {
                reconnect()
                dismiss()
            }
            Section("Wallets") {
                WalletsEditor(onChange: reconnect)
            }
            NotificationsEditor()
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}
