import Foundation

public enum ClientDevice: String, Sendable { case mac, web }

/// @MainActor: the mutable connection state (socket/backoff/stopped/started/reconnecting/heartbeat)
/// is touched from URLSession completion handlers and Tasks. Pinning the whole class to the main
/// actor means every check-then-set guard (start's `started`, scheduleReconnect's `reconnecting`)
/// runs on one actor — no data race. The class is already created on the main actor and already
/// hopped to it for every store write.
@MainActor
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

    public func setScope(_ scope: String) {
        store.scope = scope // set synchronously so applied states match (no race)
        subscribe(scope)
        onSync?()
    }

    private func subscribe(_ scope: String) {
        send(#"{"type":"subscribe","scope":"\#(scope)"}"#)
    }

    private func wsURL(token: String) -> URL? {
        // Anchor the scheme swap to the PREFIX — a blanket http→ws replace would corrupt any host/path
        // that contains "http" into an unconnectable URL.
        let api = Config.apiURL
        let base: String
        if api.hasPrefix("https") {
            base = "wss" + api.dropFirst("https".count)
        } else if api.hasPrefix("http") {
            base = "ws" + api.dropFirst("http".count)
        } else {
            base = api
        }
        return URL(string: "\(base)/live?token=\(token)")
    }

    private func connect() {
        reconnecting = false
        guard Config.isConfigured else {
            store.setConnection(.unconfigured)
            return // no password yet — wait for Settings → reconnect rather than failing in a loop
        }
        store.setConnection(.connecting)
        // Fetch a fresh JWT (re-logins from the stored password if needed) before opening the socket.
        Task { [weak self] in
            guard let self else { return }
            guard let token = await Auth.shared.token(), let url = self.wsURL(token: token) else {
                self.store.setConnection(.unauthorized)
                self.scheduleReconnect()
                return
            }
            // Re-check AFTER the await: stop() or a heartbeat-triggered scheduleReconnect() may have
            // landed while we fetched the token. Opening a socket now would leak it (a parallel reconnect
            // owns the connection) — bail and let that path drive.
            if self.stopped || self.reconnecting { return }
            let t = URLSession.shared.webSocketTask(with: url)
            self.task = t
            t.resume()
            self.sendPresence()
            // Re-assert our scope on every (re)connect — the server defaults new connections to
            // "all", so without this a wallet-scoped client would receive (and reject) "all" states.
            self.subscribe(self.store.scope)
            self.startHeartbeat()
            self.receive()
            self.onSync?() // pull closed history + stats over REST on (re)connect
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    self.store.setConnection(.live)
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
    }

    private func handle(_ data: Data) {
        let msg: ServerMessage
        do {
            msg = try ServerMessage(from: data)
        } catch {
            // Don't silently swallow a decode failure: the socket stays .live but the numbers would
            // freeze (a renamed/null backend field drops the whole non-optional state message). Log it
            // so the schema drift is diagnosable instead of an invisible freeze.
            NSLog("[LiveClient] failed to decode server message: %@", String(describing: error))
            return
        }
        switch msg {
        case .state(let state): store.apply(state)
        case .event:
            onSync?() // raw live feed: a transition (e.g. close) changes history → refresh, no banner
        case .notify(let event):
            // Rule-gated by the backend (disabled rules never reach here) → safe to show.
            if Config.notificationsEnabled { Notifier.show(event) }
        case .closedChanged:
            onSync?() // a close was just persisted → refresh history, no banner (the alert comes later)
        case .health(let h): store.setHealth(h)
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
        // A rejected token may just be expired — drop the cache so the next connect re-logins.
        if unauthorized { Task { await Auth.shared.invalidate() } }
        store.setConnection(unauthorized ? .unauthorized : .offline)
        let delay = backoff
        backoff = min(backoff * 2, 15)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !self.stopped else { return }
            self.connect()
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
            if error != nil { Task { @MainActor in self?.scheduleReconnect() } }
        }
    }

    private func sendPresence() {
        // Report active only when we'll actually SHOW a native banner: present (foreground/awake)
        // AND notifications enabled here. Otherwise the server would route "native" to us and skip
        // Bark — a muted device would swallow the alert (black hole). Reporting inactive lets
        // routing fall through to another open app, or to Bark on the phone.
        let active = presenceActive() && Config.notificationsEnabled
        send(#"{"type":"presence","device":"\#(device.rawValue)","active":\#(active)}"#)
    }

    /// Send a control frame; if the socket is broken the send fails → drop it and reconnect
    /// rather than silently losing the subscribe/presence and stalling on a dead connection.
    private func send(_ json: String) {
        guard let task else { return }
        task.send(.string(json)) { [weak self] error in
            if error != nil { Task { @MainActor in self?.scheduleReconnect() } }
        }
    }
}
