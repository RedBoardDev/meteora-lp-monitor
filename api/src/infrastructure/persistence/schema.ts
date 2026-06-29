import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// epoch-millisecond timestamp (Date.now()); fits a JS number, stored as bigint.
const ms = (name: string) => bigint(name, { mode: 'number' });

export const positions = pgTable(
  'positions',
  {
    positionAddress: text('position_address').primaryKey(),
    wallet: text('wallet').notNull(),
    poolAddress: text('pool_address').notNull(),
    tokenX: text('token_x'),
    tokenY: text('token_y'),
    tokenXMint: text('token_x_mint'),
    tokenXIcon: text('token_x_icon'),
    tokenYIcon: text('token_y_icon'),
    status: text('status').notNull(), // 'open' | 'pending_close' | 'closed'
    // Strategy family (Spot/Curve/BidAsk) decoded once from the on-chain open tx; immutable.
    strategy: text('strategy'),
    pnlSol: doublePrecision('pnl_sol'),
    pnlPctSol: doublePrecision('pnl_pct_sol'),
    sizeSol: doublePrecision('size_sol'),
    depositSol: doublePrecision('deposit_sol'),
    withdrawSol: doublePrecision('withdraw_sol'),
    claimedFeesSol: doublePrecision('claimed_fees_sol'),
    unclaimedFeesSol: doublePrecision('unclaimed_fees_sol'),
    // Residual revalued at the live market (Jupiter) price at close; kept separate from pnl_sol so
    // the periodic pool-price resync never overwrites the market reprice.
    marketPnlSol: doublePrecision('market_pnl_sol'),
    minPrice: doublePrecision('min_price'),
    maxPrice: doublePrecision('max_price'),
    poolPrice: doublePrecision('pool_price'),
    rangeStatus: text('range_status'),
    oorSince: ms('oor_since'),
    openedAt: ms('opened_at'),
    closedAt: ms('closed_at'),
    durationSeconds: integer('duration_seconds'),
    updatedAt: ms('updated_at').notNull(),
  },
  (t) => [
    index('idx_positions_wallet_status').on(t.wallet, t.status),
    index('idx_positions_wallet_closed_at').on(t.wallet, t.closedAt),
    // Serves the 'all'/stats scope (status='closed' ORDER BY closed_at) without a leading wallet.
    index('idx_positions_status_closed_at').on(t.status, t.closedAt),
    // Covers statsAggregate's exact filter (wallet IN … AND status='closed' AND closed_at >= since) so
    // it's an index range, not a heap recheck on a partial-match index.
    index('idx_positions_wallet_status_closed_at').on(t.wallet, t.status, t.closedAt),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// --- Decoupled on-chain DLMM engine: raw liquidity legs decoded from chain (no Meteora API). ---
// Each row is one deposit/withdraw/claim movement decoded from a DLMM Anchor event, with the active
// bin at that tx (the historical price anchor). Per-position PnL is computed from these, all-history.
export const dlmmLegs = pgTable(
  'dlmm_legs',
  {
    id: serial('id').primaryKey(),
    signature: text('signature').notNull(),
    wallet: text('wallet').notNull(),
    position: text('position').notNull(),
    lbPair: text('lb_pair').notNull(),
    kind: text('kind').notNull(), // 'deposit' | 'withdraw' | 'claim'
    activeBinId: integer('active_bin_id').notNull(),
    // raw u64 token lamports as decimal strings (can exceed JS/​int64 safe range for big memecoins).
    amountX: text('amount_x').notNull(),
    amountY: text('amount_y').notNull(),
    blockTime: bigint('block_time', { mode: 'number' }), // unix seconds (tx.blockTime)
  },
  (t) => [
    index('idx_dlmm_legs_wallet').on(t.wallet),
    index('idx_dlmm_legs_position').on(t.position),
    index('idx_dlmm_legs_signature').on(t.signature),
  ],
);

// Per-pool DLMM metadata (binStep / SOL side / mints), decoded once from the LbPair account. These are
// immutable on-chain, so caching them here lets the projection skip the per-pool getAccountInfo on every
// boot — the dominant first-sync RPC cost. `sol_side` is null for a non-SOL-quote pool.
export const dlmmPools = pgTable('dlmm_pools', {
  poolAddress: text('pool_address').primaryKey(),
  binStep: integer('bin_step').notNull(),
  solSide: text('sol_side'), // 'X' | 'Y' | null
  mintX: text('mint_x').notNull(),
  mintY: text('mint_y').notNull(),
});

// Per-wallet ingest progress: page backward from newest, persist the boundary signatures so an
// incremental run only fetches what's new and a backfill can resume after an interruption.
export const dlmmIngestCursor = pgTable('dlmm_ingest_cursor', {
  wallet: text('wallet').primaryKey(),
  oldestSig: text('oldest_sig'), // furthest-back signature reached so far
  newestSig: text('newest_sig'), // newest signature seen at last run (incremental floor)
  complete: boolean('complete').notNull().default(false), // reached genesis / end of history
  updatedAt: ms('updated_at').notNull(),
});

// Persisted wallet cash-flow: one row per (wallet, tx) with the wallet's net SOL+WSOL movement and
// whether it's trading (swap / DLMM lifecycle) vs external (CEX in/out). The wallet PnL curve is then
// a pure SQL aggregation over these rows — no live chain paging per request. Populated once at backfill
// (full history) and topped up incrementally on the live cadence; immutable per signature.
export const walletFlows = pgTable(
  'wallet_flows',
  {
    wallet: text('wallet').notNull(),
    signature: text('signature').notNull(),
    ts: ms('ts').notNull(), // unix SECONDS (matches the Helius Enhanced tx.timestamp)
    solFlow: doublePrecision('sol_flow').notNull(), // signed net SOL+WSOL change, in SOL
    isTrading: boolean('is_trading').notNull(),
    type: text('type').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.wallet, t.signature] }), // dedup → re-paging is idempotent
    index('idx_wallet_flows_wallet_ts').on(t.wallet, t.ts),
  ],
);

// Pre-aggregated daily rollup of wallet_flows — one row per (wallet, UTC epoch-day) holding that day's
// summed trading + external SOL. Maintained incrementally as flows are ingested, so serving the PnL
// curve is a read over ~days rows instead of a full scan + per-row date-format over millions of flows
// (measured ~350× on the worst case). The raw wallet_flows stays the source of truth; this is derived.
export const walletFlowDaily = pgTable(
  'wallet_flow_daily',
  {
    wallet: text('wallet').notNull(),
    day: integer('day').notNull(), // UTC epoch-day = floor(ts_seconds / 86400)
    trading: doublePrecision('trading').notNull(),
    external: doublePrecision('external').notNull(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.day] })],
);

// Forward-only Net Worth history: the TRUE on-chain wallet total (tvl + idle) sampled into 15-min
// UTC buckets. There is no reliable historical mark-to-market, so this is only ever written going
// forward from the live `state` stream — last write in a bucket wins. The PK already serves the
// (wallet, bucket) range scan the curve reads.
export const networthSnapshots = pgTable(
  'networth_snapshots',
  {
    wallet: text('wallet').notNull(),
    bucket: integer('bucket').notNull(), // UTC 15-min bucket = floor(unix_seconds / 900)
    ts: ms('ts').notNull(), // epoch ms of the sample that landed in this bucket
    walletTotalSol: doublePrecision('wallet_total_sol').notNull(),
    tvlSol: doublePrecision('tvl_sol').notNull(),
    idleSol: doublePrecision('idle_sol').notNull(),
  },
  (t) => [primaryKey({ columns: [t.wallet, t.bucket] })],
);

// Per-wallet flow-ingest progress — same shape/semantics as dlmm_ingest_cursor (page newest→genesis,
// resume from oldestSig, top-up until the previously-seen newestSig).
export const walletFlowCursor = pgTable('wallet_flow_cursor', {
  wallet: text('wallet').primaryKey(),
  oldestSig: text('oldest_sig'),
  newestSig: text('newest_sig'),
  complete: boolean('complete').notNull().default(false),
  updatedAt: ms('updated_at').notNull(),
});

// Browser Web Push subscriptions, per account. An event for a wallet pushes to the subscriptions of
// every account that watches it (join with user_watched_wallets); expired endpoints (404/410) are pruned.
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    userId: text('user_id').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('idx_push_user').on(t.userId)],
);

// --- Multi-tenant accounts (public web). The owner is a seeded user with is_owner = true. ---
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  // The Solana wallet address = the account identity AND the username (unique). Proven by a one-time
  // wallet signature at registration; thereafter the account is protected by the password below.
  address: text('address').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isOwner: boolean('is_owner').notNull().default(false),
  // Bumped on password reset to invalidate every previously-issued JWT for this user (session kill):
  // a token carries the version it was minted with; the auth hook rejects any token whose version is
  // stale. Without this a leaked/old session would survive a password reset.
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: ms('created_at').notNull(),
});

/** Which user watches which wallet. A wallet is monitored by the engine iff ≥1 row references it. */
export const userWatchedWallets = pgTable(
  'user_watched_wallets',
  {
    userId: text('user_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    label: text('label').notNull().default(''),
    color: text('color'),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.walletAddress] }),
    index('idx_uww_wallet').on(t.walletAddress),
  ],
);

// Owner-managed allowlist gating who may register (beta is invite-tight). Registration is rejected
// unless the connecting wallet address is present here. The owner's address is seeded from OWNER_ADDRESS.
export const walletWhitelist = pgTable('wallet_whitelist', {
  address: text('address').primaryKey(),
  note: text('note').notNull().default(''),
  addedBy: text('added_by').notNull().default(''),
  createdAt: ms('created_at').notNull(),
});

// Single-use, short-TTL nonces for the register / password-reset signature challenge. The server
// issues one bound to an address, the wallet signs the SIWS message embedding it, and it is DELETED on
// consume — so a captured signature can never be replayed. Expired rows are pruned opportunistically.
export const authNonces = pgTable(
  'auth_nonces',
  {
    nonce: text('nonce').primaryKey(),
    address: text('address').notNull(),
    expiresAt: ms('expires_at').notNull(),
    // Domain separation: a nonce minted for 'register' can't be consumed by the 'reset' flow (or vice
    // versa), so a captured challenge is bound to its intended action as well as its address.
    purpose: text('purpose').notNull().default('register'),
  },
  (t) => [index('idx_auth_nonces_address').on(t.address)],
);

// Active-session allowlist: one row per issued JWT, keyed by its `jti`. The auth hook accepts a token
// only while its jti is still here — enabling real per-session logout + revocation (tokenVersion stays
// the coarse global kill). Rows are deleted on logout / password reset and pruned once past expiry.
export const authSessions = pgTable(
  'auth_sessions',
  {
    jti: text('jti').primaryKey(),
    userId: text('user_id').notNull(),
    expiresAt: ms('expires_at').notNull(),
  },
  (t) => [index('idx_auth_sessions_user').on(t.userId)],
);

export const notifRules = pgTable(
  'notif_rules',
  {
    wallet: text('wallet'), // null = global rule (applies to every wallet)
    eventKind: text('event_kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    mode: text('mode').notNull().default('single'),
    threshold: doublePrecision('threshold'),
    oorMinutes: integer('oor_minutes'),
  },
  (t) => [
    // Postgres forbids NULL in a PK and treats NULL as distinct in a plain unique index, so key on
    // COALESCE(wallet,'') to keep global rules (NULL wallet) unique per event kind.
    uniqueIndex('uq_notif_rules_wallet_kind').on(sql`coalesce(${t.wallet}, '')`, t.eventKind),
  ],
);

// --- Near-zero-RPC watcher (Step 2): persisted swap FIFO inputs + WS checkpoint + credit telemetry. ---

// Persisted realized-PnL FIFO inputs: one row per (wallet, tx, mint) clean token↔SOL swap leg, decoded
// once from the unified getTransaction ingest. The FIFO realized-PnL walk reads these from the DB +
// only the new deltas — never re-paging the Enhanced API — so every row is immutable and the upsert is
// idempotent (ON CONFLICT DO NOTHING), which is what makes a restart cost ~0 credits.
export const swapFlows = pgTable(
  'swap_flows',
  {
    wallet: text('wallet').notNull(),
    signature: text('signature').notNull(),
    ts: bigint('ts', { mode: 'number' }).notNull(), // unix SECONDS (matches dlmm_legs.block_time)
    mint: text('mint').notNull(),
    tokenAmount: doublePrecision('token_amount').notNull(), // human token units (decimal-adjusted)
    solAmount: doublePrecision('sol_amount').notNull(), // SOL paid (buy) / received (sell) for this leg
    side: text('side').notNull(), // 'buy' | 'sell'
  },
  (t) => [
    primaryKey({ columns: [t.wallet, t.signature, t.mint] }), // dedup → re-ingest is idempotent
    index('idx_swap_flows_wallet_ts').on(t.wallet, t.ts),
  ],
);

// Per-wallet swap-flow ingest progress — same shape/semantics as wallet_flow_cursor (page newest→genesis,
// resume from oldestSig, top-up until the previously-seen newestSig).
export const swapFlowCursor = pgTable('swap_flow_cursor', {
  wallet: text('wallet').primaryKey(),
  oldestSig: text('oldest_sig'),
  newestSig: text('newest_sig'),
  complete: boolean('complete').notNull().default(false),
  updatedAt: ms('updated_at').notNull(),
});

// Durable transactionSubscribe checkpoint: the last signature + slot ingested for a wallet. A WS
// reconnect/replay resumes from this persisted slot (fromSlot) and dedups by signature, so a crash or a
// dropped socket never misses a leader open/close — the #1 no-miss guarantee of the watcher.
export const walletStreamCursor = pgTable('wallet_stream_cursor', {
  wallet: text('wallet').primaryKey(),
  lastSignature: text('last_signature'),
  lastSlot: bigint('last_slot', { mode: 'number' }), // Solana slot (fits a JS number)
  updatedAt: ms('updated_at').notNull(),
});

// Persisted RPC-credit telemetry rollup — one row per (UTC-day, exact method, wallet, code path) holding
// that bucket's summed call count + credit cost. The CreditMeter flushes its since-last-drain deltas here
// every 60s (ON CONFLICT … += delta), so /debug/rpc shows durable last-7d spend across restarts.
export const rpcCreditDaily = pgTable(
  'rpc_credit_daily',
  {
    day: integer('day').notNull(), // UTC epoch-day = floor(ms / 86_400_000)
    method: text('method').notNull(),
    wallet: text('wallet').notNull().default(''), // '' = call not attributable to a wallet
    codePath: text('code_path').notNull(),
    calls: bigint('calls', { mode: 'number' }).notNull().default(0),
    credits: bigint('credits', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.method, t.wallet, t.codePath] })],
);
