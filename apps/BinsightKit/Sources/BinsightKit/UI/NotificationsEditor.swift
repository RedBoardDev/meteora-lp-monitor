import SwiftUI
import UserNotifications

/// Shared notification settings for both Settings screens. A master toggle gates everything:
/// when on it ensures OS permission (prompts, or points to System Settings if denied) and
/// reveals the per-event rules; when off the rules are hidden and native notifs are muted.
/// Renders grouped `Section`s — drop it directly inside a `Form`.
public struct NotificationsEditor: View {
    @State private var rules: [String: NotifRule] = [:]
    @State private var masterOn = Config.notificationsEnabled
    @State private var status: UNAuthorizationStatus = .notDetermined

    public init() {}

    private var authorized: Bool { status == .authorized || status == .provisional }

    private enum Param { case none, sol, minutes }
    private struct Kind {
        let key: String
        let name: String
        let param: Param
        init(_ key: String, _ name: String, _ param: Param = .none) {
            self.key = key
            self.name = name
            self.param = param
        }
    }

    private static let groups: [(String, [Kind])] = [
        ("Positions", [Kind("position_open", "Opened"), Kind("position_close", "Closed")]),
        ("Range", [
            Kind("oor_enter", "Out of range"),
            Kind("oor_duration", "Out of range for", .minutes),
            Kind("oor_return", "Back in range"),
        ]),
        ("Thresholds", [
            Kind("pnl_threshold", "PnL ≥", .sol),
            Kind("fees_threshold", "Fees ≥", .sol),
        ]),
    ]

    public var body: some View {
        Group {
            Section("Notifications") {
                Toggle("Enable notifications", isOn: masterBinding)
                if masterOn { permissionRow }
            }
            if masterOn, authorized {
                ForEach(Self.groups, id: \.0) { group in
                    Section(group.0) {
                        ForEach(group.1, id: \.key) { kind in row(kind) }
                    }
                }
            }
        }
        .task {
            masterOn = Config.notificationsEnabled
            status = await NotifPermission.status()
            await load()
        }
    }

    private var masterBinding: Binding<Bool> {
        Binding(
            get: { masterOn },
            set: { v in
                masterOn = v
                Config.notificationsEnabled = v
                // Drop/restore this device's presence at once so routing (native vs Bark) updates
                // immediately instead of waiting for the next heartbeat.
                NotificationCenter.default.post(name: .presenceShouldRefresh, object: nil)
                if v { Task { await ensurePermission() } }
            },
        )
    }

    @ViewBuilder private var permissionRow: some View {
        switch status {
        case .authorized, .provisional:
            Label("Notifications allowed", systemImage: "checkmark.circle.fill")
                .font(.system(size: 12)).foregroundStyle(Theme.profit)
        case .denied:
            VStack(alignment: .leading, spacing: 4) {
                Text("Notifications are turned off for Binsight in System Settings.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Button("Open System Settings") { NotifPermission.openSystemSettings() }
            }
        default:
            Button("Allow notifications") { Task { await ensurePermission() } }
        }
    }

    @ViewBuilder private func row(_ k: Kind) -> some View {
        if let rule = rules[k.key] {
            Toggle(k.name, isOn: enabledBinding(k.key))
            if rule.enabled, k.param != .none {
                HStack {
                    Text(k.param == .sol ? "Threshold (SOL)" : "After (minutes)")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                    paramField(k)
                }
            }
        }
    }

    @ViewBuilder private func paramField(_ k: Kind) -> some View {
        switch k.param {
        case .sol:
            TextField("", value: solBinding(k.key), format: .number)
                .multilineTextAlignment(.trailing).frame(width: 90)
        case .minutes:
            TextField("", value: minutesBinding(k.key), format: .number)
                .multilineTextAlignment(.trailing).frame(width: 90)
        case .none:
            EmptyView()
        }
    }

    private func enabledBinding(_ key: String) -> Binding<Bool> {
        Binding(get: { rules[key]?.enabled ?? false }, set: { v in update(key) { $0.enabled = v } })
    }
    private func solBinding(_ key: String) -> Binding<Double> {
        Binding(get: { rules[key]?.threshold ?? 0 }, set: { v in update(key) { $0.threshold = v } })
    }
    private func minutesBinding(_ key: String) -> Binding<Int> {
        Binding(get: { rules[key]?.oorMinutes ?? 0 }, set: { v in update(key) { $0.oorMinutes = v } })
    }

    private func update(_ key: String, _ mutate: (inout NotifRule) -> Void) {
        guard var r = rules[key] else { return }
        mutate(&r)
        rules[key] = r
        Task { await Backend.saveNotifRule(r) }
    }

    @MainActor private func ensurePermission() async {
        var s = await NotifPermission.status()
        if s == .notDetermined {
            _ = await NotifPermission.request()
            s = await NotifPermission.status()
        }
        status = s
    }

    @MainActor private func load() async {
        let global = await Backend.notifRules().filter { $0.wallet == nil }
        rules = Dictionary(global.map { ($0.eventKind, $0) }, uniquingKeysWith: { _, latest in latest })
    }
}
