import MeteoraLPMonitorKit
import SwiftUI

struct SettingsView: View {
    @State private var launch = LaunchAtLogin.isEnabled

    var body: some View {
        Form {
            ConnectionSettingsSection {
                NotificationCenter.default.post(name: .reconnect, object: nil)
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
