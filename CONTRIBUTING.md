# Contributing to Meteora LP Monitor

## Prerequisites

- **Node 22** (see `.nvmrc`) and **Yarn 4** — `corepack enable` then `yarn install`.
- For the apps: **Xcode 16+** and **XcodeGen** (`brew install xcodegen`). A free Apple ID is
  enough (signs locally; iOS device builds expire after 7 days).

## Layout

```
api/         Fastify + TypeScript engine (DDD/hexagonal: domain / application / infrastructure)
shared/      zod contract shared by the API (the Swift clients mirror it)
apps/        SwiftUI clients sharing the MeteoraLPMonitorKit Swift package (macOS + iOS)
Makefile     one entrypoint: setup, dev-api, install-mac, run-ios, install-ios, verify…
```

## Workflow

1. `make setup` (creates `.env`), then fill `API_TOKEN` + `SOLANA_WS_URL` (a Helius `wss://` URL).
2. `make dev-api` to run the API; `make run-ios` / `make install-mac` for the clients.
3. Before opening a PR: **`make verify`** (typecheck + Biome + tests) and `make apps-test`
   for the Swift package. Keep it green.
4. **Conventional commits** (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`).
5. Keep files focused (<500 lines), comments explain *why*, no secrets in the repo.

## Conventions

- TypeScript: strict, no `any` without justification, Biome-clean.
- Swift: cross-platform logic lives in `MeteoraLPMonitorKit`; app targets stay thin. No AppKit/UIKit
  in the package core. Platform-specific code behind `#if os(...)`.
- The `shared` zod schema is the source of truth for the wire contract — update it (and the
  Swift `Models.swift` mirror) together.
