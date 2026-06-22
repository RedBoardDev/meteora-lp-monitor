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
apps-gen: apps-tools ## Generate Binsight.xcodeproj from project.yml
	cd $(APPS) && xcodegen generate

.PHONY: xcode
xcode: apps-gen ## Open the Binsight project in Xcode
	open $(APPS)/Binsight.xcodeproj

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
apps-test: ## Run the shared Swift package tests (BinsightKit)
	cd $(APPS)/BinsightKit && swift test --scratch-path $(BUILD_DIR)/spm

.PHONY: install-mac
install-mac: apps-gen ## macOS: build + install to /Applications, then launch (auto-signs with your dev cert if present — needed for notifs)
	cd $(APPS) && xcodebuild -scheme BinsightMac -configuration Release \
		-derivedDataPath $(BUILD_DIR)/mac $(MAC_SIGN) $(MLPM_BAKE) build
	@killall Binsight 2>/dev/null && sleep 1 || true
	rm -rf /Applications/Binsight.app
	cp -R $(BUILD_DIR)/mac/Build/Products/Release/Binsight.app /Applications/
	open /Applications/Binsight.app
	@echo "✓ Binsight is in the menu bar (API URL + token baked from .env)."

## ─── Housekeeping ────────────────────────────────────────────────────────
.PHONY: clean
clean: ## Remove build artifacts and node_modules
	rm -rf node_modules */node_modules */dist $(BUILD_DIR) apps/Binsight.xcodeproj apps/BinsightKit/.build

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
