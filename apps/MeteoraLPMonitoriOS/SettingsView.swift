import MeteoraLPMonitorKit
import SwiftUI

struct SettingsView: View {
    let reconnect: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var apiURL = Config.apiURL
    @State private var token = Config.token

    var body: some View {
        Form {
            Section("Connection") {
                TextField("API URL", text: $apiURL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("API token", text: $token)
                Button("Save & reconnect") {
                    Config.apiURL = apiURL
                    Config.token = token
                    reconnect()
                    dismiss()
                }
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
