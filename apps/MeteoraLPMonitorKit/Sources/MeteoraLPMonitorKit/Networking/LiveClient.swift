import Foundation

public enum ClientDevice: String, Sendable { case mac, ios, web }

public final class LiveClient {
    private let store: PortfolioStore
    private let device: ClientDevice
    public var onSync: (() -> Void)?
    private var task: URLSessionWebSocketTask?
    private var backoff: UInt64 = 1
    private var stopped = false
    private var started = false
    private var heartbeat: Task<Void, Never>?
    private var reconnecting = false

    /// Whether this device counts as "present" right now. The host platform injects the real
    /// logic (macOS: not idle/asleep/locked; iOS: foreground). Default: always present.
    public var presenceActive: () -> Bool = { true }

    public init(store: PortfolioStore, device: ClientDevice) {
        self.store = store
        self.device = device
    }

    /// Idempotent: re-opening the menu-bar panel calls this repeatedly; only connect once.
    public func start() {
        if started { return }
        started = true
        stopped = false
        connect()
    }

    public func stop() {
        started = false
        stopped = true
        heartbeat?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
    }

    public func refreshNow() { onSync?() }

    /// Send a presence update immediately (call on sleep/wake/lock/foreground transitions).
    public func refreshPresence() { sendPresence() }

    /// Force a fresh connection now. Call on wake / return-to-foreground: the old socket is
    /// stale (URLSession won't report it), so we drop it and reconnect rather than guess.
    public func reconnect() {
        guard started, !stopped else { return }
        backoff = 1
        scheduleReconnect()
    }

    @MainActor
    public func setScope(_ scope: String) {
        store.scope = scope // set synchronously so applied states match (no race)
        subscribe(scope)
        onSync?()
    }

    private func subscribe(_ scope: String) {
        task?.send(.string(#"{"type":"subscribe","scope":"\#(scope)"}"#)) { _ in }
    }

    private func wsURL() -> URL? {
        let base = Config.apiURL.replacingOccurrences(of: "http", with: "ws")
        return URL(string: "\(base)/live?token=\(Config.token)")
    }

    private func connect() {
        reconnecting = false
        guard Config.isConfigured else {
            Task { @MainActor in store.setConnection(.unconfigured) }
            return // no token yet — wait for Settings → reconnect rather than failing in a loop
        }
        guard let url = wsURL() else { return }
        Task { @MainActor in store.setConnection(.connecting) }
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        sendPresence()
        // Re-assert our scope on every (re)connect — the server defaults new connections to
        // "all", so without this a wallet-scoped client would receive (and reject) "all" states.
        Task { @MainActor in self.subscribe(self.store.scope) }
        startHeartbeat()
        receive()
        onSync?() // pull closed history + stats over REST on (re)connect
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                Task { @MainActor in self.store.setConnection(.live) }
                self.backoff = 1
                if case .string(let text) = message, let data = text.data(using: .utf8) {
                    self.handle(data)
                }
                self.receive()
            case .failure:
                self.scheduleReconnect()
            }
        }
    }

    private func handle(_ data: Data) {
        guard let msg = try? ServerMessage(from: data) else { return }
        switch msg {
        case .state(let state): Task { @MainActor in self.store.apply(state) }
        case .event:
            onSync?() // raw live feed: a transition (e.g. close) changes history → refresh, no banner
        case .notify(let event):
            // Rule-gated by the backend (disabled rules never reach here) → safe to show.
            if Config.notificationsEnabled { Notifier.show(event) }
        case .closedChanged:
            onSync?() // a close was just persisted → refresh history, no banner (the alert comes later)
        case .health(let h): Task { @MainActor in self.store.setHealth(h) }
        case .other: break
        }
    }

    private func scheduleReconnect() {
        guard !reconnecting, !stopped else { return }
        reconnecting = true
        heartbeat?.cancel()
        let unauthorized = task?.closeCode == .policyViolation // server closed /live with 1008
        task?.cancel(with: .goingAway, reason: nil) // drop the stale/half-dead socket
        task = nil
        Task { @MainActor in store.setConnection(unauthorized ? .unauthorized : .offline) }
        let delay = backoff
        backoff = min(backoff * 2, 15)
        Task {
            try? await Task.sleep(for: .seconds(delay))
            if !stopped { connect() }
        }
    }

    private func startHeartbeat() {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                self?.sendPresence()
                self?.ping() // detect a dead/half-open socket (e.g. after sleep) → reconnect
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    /// Liveness probe: a failed pong means the socket is dead even if `receive` never errored
    /// (happens after the Mac sleeps — URLSession leaves the task hanging silently).
    private func ping() {
        task?.sendPing { [weak self] error in
            if error != nil { self?.scheduleReconnect() }
        }
    }

    private func sendPresence() {
        // Report active only when we'll actually SHOW a native banner: present (foreground/awake)
        // AND notifications enabled here. Otherwise the server would route "native" to us and skip
        // Bark — a muted device would swallow the alert (black hole). Reporting inactive lets
        // routing fall through to another open app, or to Bark on the phone.
        let active = presenceActive() && Config.notificationsEnabled
        let json = #"{"type":"presence","device":"\#(device.rawValue)","active":\#(active)}"#
        task?.send(.string(json)) { _ in }
    }
}
