import BinsightKit
import SwiftUI

/// Tracks whether the iOS app is foreground, so presence reports active only then
/// (foreground → native in-app notif; background → routed to Bark).
private final class ForegroundState { var active = true }

@main
struct BinsightiOSApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = PortfolioStore()
    @State private var client: LiveClient
    @State private var foreground = ForegroundState()

    init() {
        let store = PortfolioStore()
        let rest = RestClient(store: store)
        let live = LiveClient(store: store, device: .ios)
        live.onSync = { rest.refresh() }
        let fg = ForegroundState()
        live.presenceActive = { fg.active }
        _store = State(initialValue: store)
        _client = State(initialValue: live)
        _foreground = State(initialValue: fg)
        Notifier.bootstrap()
    }

    var body: some Scene {
        WindowGroup {
            RootView(
                setScope: { [client] in client.setScope($0) },
                reconnect: { [client] in client.stop(); client.start() },
                refresh: { [client] in client.refreshNow() },
            )
            .environment(store)
            .tint(Theme.accent) // emerald brand accent for controls/links
            .preferredColorScheme(.dark) // premium-dark identity holds even in system light mode
            .onAppear { client.start() }
            .onChange(of: scenePhase) { _, phase in
                foreground.active = (phase == .active)
                // Back to foreground: the socket was suspended/killed in background — reconnect fresh.
                if phase == .active { client.reconnect() } else { client.refreshPresence() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .lpmPresenceShouldRefresh)) { _ in
                client.refreshPresence() // notif toggle flipped → update routing now
            }
        }
    }
}
