import BinsightKit
import SwiftUI

@main
struct BinsightMacApp: App {
    @State private var store = PortfolioStore()
    @State private var client: LiveClient
    @State private var presence = MacPresence()

    init() {
        let store = PortfolioStore()
        let rest = RestClient(store: store)
        let live = LiveClient(store: store, device: .mac)
        live.onSync = { rest.refresh() }
        let presence = MacPresence()
        live.presenceActive = { presence.isActive } // away/asleep/locked → routes to Bark
        presence.onChange = { [weak live] in live?.refreshPresence() } // flip immediately
        presence.onWake = { [weak live] in live?.reconnect() } // socket is stale after sleep
        _store = State(initialValue: store)
        _client = State(initialValue: live)
        _presence = State(initialValue: presence)
        Notifier.bootstrap()
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView()
                .environment(store)
                .tint(Theme.accent) // emerald brand accent for controls/links
                .preferredColorScheme(.dark) // premium-dark identity holds even in system light mode
                .onAppear { client.start() }
                .onReceive(NotificationCenter.default.publisher(for: .reconnect)) { _ in
                    client.stop()
                    client.start()
                }
                .onReceive(NotificationCenter.default.publisher(for: .refresh)) { _ in
                    client.refreshNow()
                }
                .onReceive(NotificationCenter.default.publisher(for: .lpmPresenceShouldRefresh)) { _ in
                    client.refreshPresence() // notif toggle flipped → update routing now
                }
                .onReceive(NotificationCenter.default.publisher(for: .setScope)) { note in
                    if let scope = note.object as? String { client.setScope(scope) }
                }
        } label: {
            if store.menuBarIsIdle {
                Image(systemName: PortfolioStore.idleSymbol) // menu bar = single static glyph
            } else {
                Text(store.menuBarText)
                    .foregroundStyle(store.menuBarColor)
                    .monospacedDigit()
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
        }
    }
}
