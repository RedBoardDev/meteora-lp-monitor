import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  API_TOKEN: z.string().min(1, 'API_TOKEN is required'),

  SOLANA_WS_URL: z.string().url(),
  SOLANA_HTTP_URL: z.string().url().optional(),

  METEORA_TARGET_RPS: z.coerce.number().positive().default(15),
  POLL_MIN_MS: z.coerce.number().int().positive().default(1000),
  POLL_MAX_MS: z.coerce.number().int().positive().default(30_000),
  POLL_IDLE_MS: z.coerce.number().int().positive().default(300_000),

  DB_PATH: z.string().default('./data/monitor.db'),
  // History depth: either a rolling window (HISTORY_DAYS) OR an absolute floor date
  // (HISTORY_SINCE, e.g. 2026-05-01) — when set, HISTORY_SINCE wins (everything after it).
  HISTORY_DAYS: z.coerce.number().int().min(1).max(365).default(365),
  HISTORY_SINCE: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'HISTORY_SINCE must be a date, e.g. 2026-05-01')
    .optional(),
  SYNC_OVERLAP_SECONDS: z.coerce.number().int().min(0).default(3600),

  BARK_KEY: z.string().default(''),
  BARK_BASE_URL: z.string().url().default('https://api.day.app'),
  PRESENCE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),

  /** Browser origins allowed by CORS (comma-separated). Native clients send no Origin. */
  WEB_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),

  /** LPAgent — authoritative closed-PnL source (residual valued at market). Empty key disables
   *  enrichment (closed PnL falls back to Meteora's raw pnlSol). Rate-limited to LPAGENT_RPM/min. */
  LPAGENT_API_KEY: z.string().default(''),
  LPAGENT_BASE_URL: z.string().url().default('https://api.lpagent.io'),
  LPAGENT_RPM: z.coerce.number().int().positive().default(5),

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
