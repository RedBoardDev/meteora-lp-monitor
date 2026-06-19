.DEFAULT_GOAL := help
SHELL := /bin/bash

## ─── Setup ───────────────────────────────────────────────────────────────
.PHONY: setup
setup: ## First run: create .env from the template (then edit AUTH_SECRET + SOLANA_WS_URL)
	@if [ -f .env ]; then echo ".env already present."; else \
		cp .env.example .env && \
		echo "✓ Created .env — now set AUTH_SECRET (≥32 chars: openssl rand -hex 32) and SOLANA_WS_URL (a Helius wss URL) in it."; fi

.PHONY: install
install: setup ## Create .env if missing, then install all workspace dependencies (Yarn Berry)
	yarn install

.PHONY: build-shared
build-shared: ## Build the shared types package (required before api typecheck)
	yarn workspace @binsight/shared build

## ─── Dev ─────────────────────────────────────────────────────────────────
.PHONY: dev-api
dev-api: build-shared ## Run the API in watch mode
	yarn workspace @binsight/api dev

## ─── Quality ─────────────────────────────────────────────────────────────
.PHONY: typecheck
typecheck: ## Typecheck every workspace (turbo resolves shared build automatically)
	yarn turbo run typecheck

.PHONY: lint
lint: ## Lint with Biome
	yarn biome lint .

.PHONY: format
format: ## Format with Biome
	yarn biome format --write .

.PHONY: check
check: ## Biome check (lint + format) without writing
	yarn biome check .

.PHONY: test
test: ## Run unit tests
	yarn turbo run test

.PHONY: verify
verify: typecheck check test ## Full local gate: typecheck + biome + tests

## ─── Build / run ─────────────────────────────────────────────────────────
.PHONY: build
build: ## Build all workspaces
	yarn turbo run build

.PHONY: start
start: ## Start the built API
	yarn workspace @binsight/api start

## ─── Docker ──────────────────────────────────────────────────────────────
.PHONY: up
up: ## Start the stack with Docker Compose
	docker compose up -d --build

.PHONY: down
down: ## Stop the Docker stack
	docker compose down

.PHONY: logs
logs: ## Tail Docker logs
	docker compose logs -f

## ─── Swift clients (Binsight: macOS menu-bar + iOS app) ─────────────────
APPS := apps
ENV_FILE := .env
# Pull defaults from the repo .env at build time → baked into the app (overridable in Settings).
envval = $(shell [ -f $(ENV_FILE) ] && sed -n 's/^$(1)=//p' $(ENV_FILE) | tail -1 | tr -d '"')
MLPM_URL := $(or $(call envval,CLIENT_API_URL),http://localhost:8787)
# Only the API URL is baked into the app; auth is address+password→JWT, entered in the app's Settings.
MLPM_BAKE := MLPM_API_URL="$(MLPM_URL)"
# Sign with the first code-signing identity in your keychain (a FREE Apple ID's "Apple
# Development" cert is enough — no $99 needed). A real signature is required for macOS
# notifications; the app is non-sandboxed so no provisioning profile is needed. Ad-hoc fallback.
SIGN_ID := $(shell security find-identity -v -p codesigning 2>/dev/null | grep -oE '[0-9A-F]{40}' | head -1)
MAC_SIGN := $(if $(SIGN_ID),CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=$(SIGN_ID) PROVISIONING_PROFILE_SPECIFIER=,CODE_SIGNING_ALLOWED=NO)
# Build artifacts go to /tmp (kept out of the repo entirely — nothing to .gitignore or clean here).
BUILD_DIR := /tmp/binsight-build

.PHONY: apps-tools
apps-tools: ## Install XcodeGen (one-off, needs Homebrew)
	@command -v xcodegen >/dev/null || brew install xcodegen

.PHONY: apps-gen
apps-gen: apps-tools ## Generate MeteoraLPMonitor.xcodeproj from project.yml
	cd $(APPS) && xcodegen generate

.PHONY: xcode
xcode: apps-gen ## Open the Binsight project in Xcode
	open $(APPS)/MeteoraLPMonitor.xcodeproj

.PHONY: notify-test
notify-test: ## Fire a test notif. Needs MLPM_ADDRESS + MLPM_PASSWORD (a registered account). KIND=oor_enter to override.
	@test -n "$(MLPM_ADDRESS)" && test -n "$(MLPM_PASSWORD)" || { \
		echo "Set MLPM_ADDRESS and MLPM_PASSWORD to a registered account, e.g.:"; \
		echo "  make notify-test MLPM_ADDRESS=<wallet> MLPM_PASSWORD=<password>"; exit 1; }
	@TOKEN=$$(curl -s -X POST -H "Content-Type: application/json" \
		-d '{"address":"$(MLPM_ADDRESS)","password":"$(MLPM_PASSWORD)"}' "$(MLPM_URL)/auth/login" \
		| sed -n 's/.*"token":"\([^"]*\)".*/\1/p'); \
	test -n "$$TOKEN" || { echo "Login failed — check MLPM_ADDRESS / MLPM_PASSWORD and that the API is running."; exit 1; }; \
	curl -s -X POST -H "Authorization: Bearer $$TOKEN" \
		"$(MLPM_URL)/debug/notify?kind=$(or $(KIND),position_close)"; echo

.PHONY: apps-test
apps-test: ## Run the shared Swift package tests (MeteoraLPMonitorKit)
	cd $(APPS)/MeteoraLPMonitorKit && swift test --scratch-path $(BUILD_DIR)/spm

.PHONY: install-mac
install-mac: apps-gen ## macOS: build + install to /Applications. TEAM=<id> to sign (needed for notifs)
	cd $(APPS) && xcodebuild -scheme MeteoraLPMonitorMac -configuration Release \
		-derivedDataPath $(BUILD_DIR)/mac $(MAC_SIGN) $(MLPM_BAKE) build
	@killall MeteoraLPMonitor 2>/dev/null && sleep 1 || true
	rm -rf /Applications/MeteoraLPMonitor.app
	cp -R $(BUILD_DIR)/mac/Build/Products/Release/MeteoraLPMonitor.app /Applications/
	open /Applications/MeteoraLPMonitor.app
	@echo "✓ Binsight is in the menu bar (API URL + token baked from .env)."

.PHONY: run-ios
run-ios: apps-gen ## iOS: build & launch on a simulator (no Apple ID needed)
	cd $(APPS) && xcodebuild -scheme MeteoraLPMonitoriOS -configuration Debug \
		-destination 'generic/platform=iOS Simulator' -derivedDataPath $(BUILD_DIR)/ios-sim \
		CODE_SIGNING_ALLOWED=NO $(MLPM_BAKE) build
	@UDID=$$(xcrun simctl list devices available | awk -F '[()]' '/iPhone/{print $$2; exit}'); \
		xcrun simctl boot $$UDID 2>/dev/null || true; open -a Simulator; \
		xcrun simctl install $$UDID $(BUILD_DIR)/ios-sim/Build/Products/Debug-iphonesimulator/MeteoraLPMonitor.app; \
		xcrun simctl launch $$UDID com.meteoralpmonitor.ios
	@echo "✓ Binsight running in the Simulator (reaches the Mac API on localhost)."

.PHONY: install-ios
install-ios: apps-gen ## iPhone: build + install on a plugged-in device (auto-detects your Team)
	@TEAM_ID="$(TEAM)"; \
		[ -n "$$TEAM_ID" ] || TEAM_ID=$$(security find-identity -v -p codesigning | grep -oE '\([A-Z0-9]{10}\)' | tr -d '()' | head -1); \
		test -n "$$TEAM_ID" || { echo "No signing identity — add your Apple ID in Xcode → Settings → Accounts, then retry."; exit 1; }; \
		echo "→ signing iOS with team $$TEAM_ID"; \
		cd $(APPS) && xcodebuild -scheme MeteoraLPMonitoriOS -configuration Debug \
			-destination 'generic/platform=iOS' -allowProvisioningUpdates DEVELOPMENT_TEAM=$$TEAM_ID \
			-derivedDataPath $(BUILD_DIR)/ios $(MLPM_BAKE) build
	@DEV=$$(xcrun devicectl list devices 2>/dev/null | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' | head -1); \
		test -n "$$DEV" || { echo "No connected iPhone found. Unlock it & trust this Mac, or run 'make xcode' → ⌘R."; exit 1; }; \
		xcrun devicectl device install app --device $$DEV $(BUILD_DIR)/ios/Build/Products/Debug-iphoneos/MeteoraLPMonitor.app
	@echo "✓ Installed. On the iPhone: Settings → General → VPN & Device Management → trust your dev cert."

.PHONY: team-id
team-id: ## Print Apple Development Team IDs from your keychain (for install-ios TEAM=...)
	@security find-identity -v -p codesigning | grep -oE '\([A-Z0-9]{10}\)' | tr -d '()' | sort -u; \
		echo "(or Xcode → Settings → Accounts → your Apple ID → Team)"

## ─── Housekeeping ────────────────────────────────────────────────────────
.PHONY: clean
clean: ## Remove build artifacts and node_modules
	rm -rf node_modules */node_modules */dist $(BUILD_DIR) apps/MeteoraLPMonitor.xcodeproj apps/MeteoraLPMonitorKit/.build

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
