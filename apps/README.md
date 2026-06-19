# Binsight — macOS + iOS clients

SwiftUI clients for the Binsight API. macOS is a menu-bar agent; iOS is a
full app. Both share **MeteoraLPMonitorKit**. Design: `DESIGN.md`.

## Structure

```
apps/
  MeteoraLPMonitorKit/      shared Swift package (no AppKit/UIKit in the core)
    Sources/MeteoraLPMonitorKit/{Models,Networking,State,Notifications,Formatting,UI}
    Tests/MeteoraLPMonitorKitTests
  MeteoraLPMonitorMac/      macOS menu-bar app (MenuBarExtra) — thin shell
  MeteoraLPMonitoriOS/      iOS app (NavigationStack) — thin shell
  project.yml        XcodeGen: the package + both app targets
```

The package holds everything portable (wire types, WS/REST clients, store, notifier,
formatters, shared SwiftUI components). Each app target only owns its presentation shell.

## Install (one command each, from the repo root)

Each device is independent — run only the one(s) you want:

```sh
make install-mac                 # macOS menu-bar app → /Applications, then launches it
make run-ios                     # iOS app on the Simulator (no Apple ID needed)
make install-ios TEAM=XXXXXXXXXX # physical iPhone (needs your Apple ID team — see make team-id)
```

Helpers: `make team-id` (lists your Apple Team IDs), `make xcode` (open the project),
`make apps-gen` (regenerate `MeteoraLPMonitor.xcodeproj`). First run installs XcodeGen via Homebrew.

### Zero config: API URL + token are baked from `.env`

`make` reads the repo `.env` at build time and bakes the defaults into the app
(`API_TOKEN` → token; URL → `localhost` by default). Nothing to type on first launch.
You can still override anything in the app's **Settings** (persisted to Keychain/UserDefaults).

For a **physical iPhone** `localhost` won't reach the Mac, so set the reachable address in `.env`:
```sh
CLIENT_API_URL=http://<mac-LAN-or-tailscale-ip>:8787   # optional; mac & simulator ignore it
```
(The iOS Info.plist already allows plaintext local-network HTTP for LAN/Tailscale.)

### iPhone signing (Apple requirement)

`make install-ios` needs `TEAM=` (a free Apple ID works; apps expire after 7 days, reinstall).
First launch on device: **Settings → General → VPN & Device Management → trust your cert**.
If CLI device detection fails, `make xcode` → pick your iPhone → ⌘R does the same.

### Manual / CLI checks
```sh
cd apps/MeteoraLPMonitorKit && swift test
```

## How it fits the system

- Each client sends presence over the WebSocket (`device: mac | ios`). While a client is
  active, events show as native notifications there; otherwise the backend pushes to Bark.
- Planned: App Group (`group.com.meteoralpmonitor`) + WidgetKit/Live Activity (P2/P3).
