import MeteoraLPMonitorKit
import SwiftUI

struct SettingsView: View {
    @State private var apiURL = Config.apiURL
    @State private var token = Config.token
    @State private var launch = LaunchAtLogin.isEnabled

    var body: some View {
        Form {
            Section("Connection") {
                TextField("API URL", text: $apiURL)
                SecureField("API token", text: $token)
                Button("Save & reconnect") {
                    Config.apiURL = apiURL
                    Config.token = token
                    NotificationCenter.default.post(name: .reconnect, object: nil)
                }
            }
            Section("Behavior") {
                Toggle("Launch at login", isOn: $launch)
                    .onChange(of: launch) { _, v in LaunchAtLogin.set(v) }
            }
            Section("Wallets") {
                WalletsEditor(onChange: {
                    NotificationCenter.default.post(name: .reconnect, object: nil)
                })
            }
            NotificationsEditor()
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 620)
    }
}

extension Notification.Name {
    static let reconnect = Notification.Name("MeteoraLPMonitorReconnect")
    static let refresh = Notification.Name("MeteoraLPMonitorRefresh")
    static let setScope = Notification.Name("MeteoraLPMonitorSetScope")
}
