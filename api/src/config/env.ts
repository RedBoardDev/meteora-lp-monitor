import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),

  /** The secret that signs every session JWT (HS256). REQUIRED — no default, no placeholder — so the
   *  schema fails fast at boot if it is missing or too short. Generate a ≥32-char random value:
   *  `openssl rand -hex 32`. Keep it STABLE: changing it invalidates every existing session. */
  AUTH_SECRET: z
    .string()
    .min(32, 'AUTH_SECRET is required: a ≥32-char random secret (generate: openssl rand -hex 32)'),
  /** The owner's Solana wallet address: auto-whitelisted on boot and flagged `isOwner` when it
   *  registers (the bootstrap account). Empty = no owner seeded (populate the whitelist another way). */
  OWNER_ADDRESS: z
    .string()
    .default('')
    .refine(
      (v) => v === '' || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v),
      'OWNER_ADDRESS must be a base58 Solana address',
    ),

  /** Open-access mode. When 'true', registration is address + password only — NO wallet signature and
   *  NO whitelist (anyone can create an account for any address), accounts are single-wallet, and
   *  notifications are disabled. The default 'false' keeps the secure SIWS + whitelist + multi-wallet
   *  behavior. Reversible per deployment; the SIWS/whitelist code stays in place either way. */
  OPEN_ACCESS_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** Master switch for the on-chain realized-PnL pass (the chained-FIFO `market_pnl_sol` writer). It
   *  needs the wallet's FULL buys/sells history, fetched from Helius and NOT persisted, so on a cold
   *  in-memory cache (every restart) it re-pages the entire SWAP history — prohibitively expensive on a
   *  very active wallet and unscalable to many wallets. Set 'false' to disable: closed positions keep
   *  their already-persisted `market_pnl_sol`, new closes fall back to the pool mark, RPC cost ≈ 0. */
  REALIZED_PNL_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Credit kill-switch / anomaly thresholds (CreditMeter) — env-overridable so a deploy can cap spend
  // HARD: a tiny CREDIT_WALLET_DAILY_BUDGET halts a runaway (e.g. a one-time SWAP seed) at a few Enhanced
  // pages, which is exactly the safety net for validating near-zero behavior on a low remaining budget.
  // Defaults sit above legitimate steady-state, far below the incident burst (see the Helius credit model).
  CREDIT_ALARM_PER_MIN: z.coerce.number().int().nonnegative().default(2000),
  CREDIT_GLOBAL_KILL_PER_MIN: z.coerce.number().int().nonnegative().default(10_000),
  CREDIT_WALLET_DAILY_BUDGET: z.coerce.number().int().nonnegative().default(5_000),

  SOLANA_WS_URL: z.string().url(),
  SOLANA_HTTP_URL: z.string().url().optional(),

  // RPC rate limits (requests/sec) enforced at the Connection — every Solana call shares this
  // budget so the live engine and the history backfill never blow the provider's plan (429 storms).
  // Defaults match the Helius free tier; raise them via env when on a higher plan.
  SOLANA_RPS: z.coerce.number().positive().default(10),
  SOLANA_GPA_RPS: z.coerce.number().positive().default(5),
  SOLANA_DAS_RPS: z.coerce.number().positive().default(2),
  SOLANA_SEND_RPS: z.coerce.number().positive().default(1),
  /** Share of the overall RPC budget reserved for the LIVE path (snapshots/valuation); the remainder
   *  goes to a SEPARATE backfill/projection lane so a history backfill can never starve live. */
  SOLANA_LIVE_FRACTION: z.coerce.number().positive().lt(1).default(0.6),
  /** Max wallets backfilling history concurrently (onboarding admission control). The binding cost is
   *  the per-wallet history sweep; raise this only with the RPC tier's headroom (the backfill lane). */
  BACKFILL_CONCURRENCY: z.coerce.number().int().positive().default(3),

  METEORA_TARGET_RPS: z.coerce.number().positive().default(15),
  POLL_MIN_MS: z.coerce.number().int().positive().default(1000),
  POLL_MAX_MS: z.coerce.number().int().positive().default(30_000),
  POLL_IDLE_MS: z.coerce.number().int().positive().default(300_000),

  /** Positions table source: 'onchain' (the decoupled DLMM engine, default) or 'meteora' (datapi, legacy
   *  escape hatch). 'onchain' makes the on-chain engine the single source — backfill on register, delta
   *  ingest on WS activity, projection synced to the positions table; the Meteora open/closed reconcile is
   *  bypassed. Verified live (62.27 SOL realized over 15 754 positions, symbols + economics correct). */
  POSITIONS_SOURCE: z.enum(['meteora', 'onchain']).default('onchain'),

  /** Postgres connection string (self-hosted via docker-compose). */
  DATABASE_URL: z.string().default('postgres://meteora:meteora@localhost:5435/meteora'),
  // History depth: either a rolling window (HISTORY_DAYS) OR an absolute floor date
  // (HISTORY_SINCE, e.g. 2026-05-01) — when set, HISTORY_SINCE wins (everything after it).
  HISTORY_DAYS: z.coerce.number().int().min(1).max(365).default(365),
  HISTORY_SINCE: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'HISTORY_SINCE must be a date, e.g. 2026-05-01')
    .optional(),

  BARK_KEY: z.string().default(''),
  BARK_BASE_URL: z.string().url().default('https://api.day.app'),
  PRESENCE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),

  // Web Push (browser/PWA notifications). Generate once with `npx web-push generate-vapid-keys` and
  // put both keys in .env — they must stay STABLE (existing subscriptions are bound to the public key).
  // Push is disabled when either key is empty.
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:admin@binsight.local'),

  /** Browser origins allowed by CORS (comma-separated). Native clients send no Origin. */
  WEB_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),

  /** Jupiter Price API v3 (free, no key) — live market price to revalue OPEN positions' token
   *  holdings (Meteora's pool-spot mark misprices illiquid/out-of-range tokens). */
  JUPITER_PRICE_URL: z.string().url().default('https://lite-api.jup.ag/price/v3'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  solanaHttpUrl: string;
  /** Effective history window in days for the full sync (derived from HISTORY_SINCE or HISTORY_DAYS). */
  historyDays: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    console.error('Invalid configuration:');
    console.error(JSON.stringify(parsed.error.format(), null, 2));
    process.exit(1);
  }
  const data = parsed.data;
  // Derive an HTTP RPC url from the WS one when not explicitly set.
  const solanaHttpUrl =
    data.SOLANA_HTTP_URL ??
    data.SOLANA_WS_URL.replace(/^wss?:/, (m) => (m === 'wss:' ? 'https:' : 'http:'));
  // HISTORY_SINCE (absolute floor date) overrides HISTORY_DAYS (rolling window) when set.
  const historyDays = data.HISTORY_SINCE
    ? Math.max(1, Math.ceil((Date.now() - Date.parse(data.HISTORY_SINCE)) / 86_400_000))
    : data.HISTORY_DAYS;
  return { ...data, solanaHttpUrl, historyDays };
}
