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
- **Resilient engine** — a decoupled on-chain DLMM engine (history backfill when a wallet registers,
  then Solana WS delta ingest) is the default source; designed to never miss a position (late is fine,
  missing is not). An optional legacy Meteora datapi poller is available via `POSITIONS_SOURCE=meteora`.

## Quick start

```sh
corepack enable                 # Yarn 4
make setup                      # creates .env from the template
#   → edit .env: set AUTH_SECRET (≥32 chars, e.g. `openssl rand -hex 32`) and SOLANA_WS_URL (a Helius wss:// URL).
#     Account passwords are set during web registration, not in .env.
make install                    # install dependencies
make dev-api                    # run the API on :8787  (a Solana WS endpoint is REQUIRED)
```

First register a wallet on the web client (connect a wallet → sign a one-time message → choose a
password). Then install the native clients (each independent — the API URL is baked from your `.env`;
you sign in everywhere with that wallet **address + password** in the app's Settings):

```sh
make install-mac                # macOS menu-bar app → /Applications, signed with your free cert
make run-ios                    # iOS app on a simulator (no Apple ID needed)
make install-ios                # a plugged-in iPhone (free Apple ID; see make team-id)
```

Add the wallets to monitor in the app's **Settings** (and sign in with your address + password there).
On macOS, allow notifications when prompted; for your iPhone away from the Mac, install the
[Bark](https://bark.day.app) app and set its key in the API config.

## Commands

`make help` lists everything. Key: `make verify` (typecheck + Biome + tests), `make apps-test`
(Swift package tests), `make install-mac` / `run-ios` / `install-ios`, `make notify-test`,
`make up` / `down` / `logs` (Docker Compose: Postgres + API).

## Notes

- A Solana WS/RPC endpoint (e.g. **Helius**, free tier works) is **required** to boot the API.
- Auth is per-account, keyed on a Solana wallet address: clients `POST {address, password}` to
  `/auth/login` and receive a JWT (Bearer for REST, `?token=` for the WebSocket). The JWT signing key
  is `AUTH_SECRET`. No static API token.

## License

[MIT](./LICENSE) © RedBoardDev
