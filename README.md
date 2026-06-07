# Meteora LP Monitor

Real-time, self-hosted monitor for your **Meteora DLMM liquidity positions** on Solana —
a menu-bar app on **macOS**, a native **iOS** app, and the API that feeds them.
PnL is faithful to on-chain (`pnlSol`, validated). Free to run (no paid Apple account needed).

## Why

You open LP positions on Meteora and want to know — at a glance and via notifications — your
live PnL, what's in/out of range, your fees, your wallet total, and your realized PnL today,
across multiple wallets. Meteora LP Monitor does that without a dashboard to babysit.

## What you get

- **macOS menu-bar app** — live PnL, wallet total, fees, today's realized PnL, open positions
  with range bars, closed history; native notifications when you're at your Mac.
- **iOS app** — the same, native, with pull-to-refresh.
- **Notifications** — native when the app is active; **Bark** push to your iPhone when it isn't
  (presence-aware, no double-notify). No Apple Developer Program required.
- **Resilient engine** — Solana WS + adaptive Meteora polling + full reconciliation; designed to
  never miss a position (late is fine, missing is not).

## Quick start

```sh
corepack enable                 # Yarn 4
make setup                      # creates .env from the template
#   → edit .env: set API_TOKEN (a long random string) and SOLANA_WS_URL (a Helius wss:// URL)
make install                    # install dependencies
make dev-api                    # run the API on :8787  (a Solana WS endpoint is REQUIRED)
```

Then install the clients (each independent — API URL + token are baked from your `.env`):

```sh
make install-mac                # macOS menu-bar app → /Applications, signed with your free cert
make run-ios                    # iOS app on a simulator (no Apple ID needed)
make install-ios                # a plugged-in iPhone (free Apple ID; see make team-id)
```

Add the wallets to monitor in the app's **Settings** (or override the URL/token there).
On macOS, allow notifications when prompted; for your iPhone away from the Mac, install the
[Bark](https://bark.day.app) app and set its key in the API config.

## Commands

`make help` lists everything. Key: `make verify` (typecheck + Biome + tests), `make apps-test`
(Swift package tests), `make install-mac` / `run-ios` / `install-ios`, `make notify-test`,
`make up` / `down` / `logs` (Docker, API only).

## Notes

- A Solana WS/RPC endpoint (e.g. **Helius**, free tier works) is **required** to boot the API.
- The API is protected by a single `API_TOKEN` (Bearer for REST, `?token=` for
  the WebSocket).

## License

[MIT](./LICENSE) © RedBoardDev
