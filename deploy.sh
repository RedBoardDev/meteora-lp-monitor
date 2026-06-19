#!/usr/bin/env bash
# (Re)deploy the production stack from the latest main.
#
# Durable data lives in the named `pgdata` Docker volume and is PRESERVED across rebuilds, restarts
# and reboots. This script never tears the stack down, so no data is lost. NEVER run the compose
# `down -v` flag (or `docker volume rm meteora_pgdata`) — that deletes the database.
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE="docker compose -f docker-compose.prod.yml"

echo "→ Fetching latest main…"
git fetch --prune origin
git checkout main
git pull --ff-only

echo "→ Building images and (re)starting (the pgdata volume is kept)…"
$COMPOSE up -d --build

echo "→ Pruning dangling images…"
docker image prune -f

echo "→ Status:"
$COMPOSE ps
