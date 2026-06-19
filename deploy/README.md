# Production deployment

Single VPS, fronted by the host **nginx**. The app runs as three containers via
`docker-compose.prod.yml`; nginx terminates TLS for `binsight.thomasott.fr` and routes traffic.

```
                       ┌──────────────── VPS ────────────────┐
 browser ──HTTPS──▶ host nginx ─┬─ "/"     ─▶ web  127.0.0.1:3000  (Next.js UI + /api BFF)
                                └─ "/live"  ─▶ api  127.0.0.1:8787  (WebSocket only)
                                              web ──internal──▶ api ──internal──▶ postgres
```

Only `web` and the API's `/live` WebSocket are reachable from the browser. The rest of the API and
Postgres stay on the internal Docker network. The containers bind to `127.0.0.1` only.

## 1. Prerequisites (on the VPS)

- Docker Engine + the Compose plugin (`docker compose version`).
- The existing host nginx + `certbot` (with the nginx or webroot plugin).
- The repo cloned somewhere, e.g. `/opt/binsight`.

## 2. DNS (you handle this in Route53)

An `A` record `binsight.thomasott.fr` → the VPS public IP.

## 3. `.env.prod` (create on the VPS — never commit it)

Create `.env.prod` next to `docker-compose.prod.yml`. `DATABASE_URL` is injected by compose, so do
**not** set it here. Required and notable vars:

| Var | Required | Notes |
|-----|----------|-------|
| `AUTH_SECRET` | ✅ | JWT signing key, ≥32 chars. Generate once, keep STABLE: `openssl rand -hex 32`. Changing it logs everyone out. |
| `SOLANA_WS_URL` | ✅ | `wss://mainnet.helius-rpc.com/?api-key=…` (Helius). |
| `WEB_ORIGINS` | ✅ | `https://binsight.thomasott.fr` — also binds the wallet sign-in (SIWS) origin and the WS origin allow-list. |
| `OWNER_ADDRESS` | recommended | Your wallet address: auto-whitelisted + flagged owner when it registers. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | optional | Web Push. Generate once: `npx web-push generate-vapid-keys`. Must stay STABLE. |
| `SOLANA_RPS`, `SOLANA_GPA_RPS`, … | optional | RPC budget; defaults are the Helius free tier. |
| `HISTORY_DAYS` / `HISTORY_SINCE` | optional | History depth. |
| `BARK_KEY` | optional | Owner iPhone push fallback. |

`NEXT_PUBLIC_API_WS_URL` is **baked at build time** (the browser needs it). It defaults to
`wss://binsight.thomasott.fr` in compose — override only if your hostname differs:
`NEXT_PUBLIC_API_WS_URL=wss://other.host docker compose -f docker-compose.prod.yml build web`.

## 4. TLS certificate (certbot)

```bash
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d binsight.thomasott.fr
```
(or `sudo certbot --nginx -d binsight.thomasott.fr` to let certbot edit nginx directly). Renewal is
handled by the certbot systemd timer.

## 5. nginx vhost

```bash
sudo cp deploy/nginx/binsight.thomasott.fr.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/binsight.thomasott.fr.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 6. First deploy

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f api    # watch "migrations applied" then the engine start
```

The database starts EMPTY. To create the owner account, open `https://binsight.thomasott.fr`, choose
**Create one with your wallet**, connect the `OWNER_ADDRESS` wallet, sign the one-time message and set
a password. After that, sign in everywhere with that address + password.

## 7. Updating (redeploy)

```bash
./deploy.sh
```
Pulls `main`, rebuilds the images and restarts. **The data volume is preserved.**

## 8. Data persistence & safety ⚠️

**All durable data lives in one place: the Postgres named volume `meteora_pgdata`.** The API and web
containers are **stateless on disk** (every byte of state — positions, wallet flows, accounts,
sessions, ingest cursors — is in Postgres; nothing is written to a container filesystem).

What this means:

- **Preserved across** `up -d --build`, container restarts, VPS reboots, and
  `docker compose -f docker-compose.prod.yml down` (without `-v`). Rebuilding images never touches the
  volume.
- **DESTROYED only by** `docker compose ... down -v`, `docker volume rm meteora_pgdata`, or
  `docker volume prune`. **Never run these** unless you intend to wipe everything. `deploy.sh` never
  tears the stack down, so routine deploys are safe.
- **Migrations are idempotent.** drizzle-orm records applied migrations in a `__drizzle_migrations`
  table and only runs pending ones, so a redeploy re-applies nothing. The one destructive migration
  (`0008`, the legacy email→wallet cutover) only runs on the **first** boot of a fresh database — where
  its `DELETE`s are no-ops — and never again. Open positions / flows / DLMM legs are keyed by wallet
  address and are not touched by it.
- **Restart behaviour:** `restart: unless-stopped` brings every container back after a crash or reboot.
  On start the API applies any pending migration, re-subscribes the Solana WebSocket, and **resumes
  on-chain ingest from the per-wallet cursors stored in Postgres** (`dlmm_ingest_cursor`,
  `wallet_flow_cursor`) — no re-download, no duplicates, no data loss.

### Backups (recommended — cron it)

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U meteora meteora | gzip > "meteora-$(date +%F).sql.gz"
```

Restore into a fresh volume:

```bash
gunzip -c meteora-YYYY-MM-DD.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres psql -U meteora meteora
```

## 9. Ops

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml restart api
```
