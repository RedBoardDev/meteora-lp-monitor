import type {
  AccessEntry,
  ClosedPosition,
  LiveEvent,
  NotifRule,
  OpenPosition,
  PositionBins,
  PositionHistory,
  RuntimeSettings,
  Stats,
  StrategyFamily,
  WalletOverview,
} from '@binsight/shared';
import type {
  DailyFlow,
  DlmmLeg,
  FlowCursor,
  IngestCursor,
  LoadedPoolMeta,
  OnchainWalletSnapshot,
  ResidualSell,
  SnapshotPlan,
  StoredLeg,
  WalletFlowRow,
} from '@/domain/dlmm';

/** A pool the wallet has positions in. */
export interface PoolRef {
  poolAddress: string;
  tokenX: string;
  tokenY: string;
  tokenXMint: string;
  tokenYMint: string;
  tokenXIcon?: string;
  tokenYIcon?: string;
}

/** Token spot prices in SOL via an aggregator (Jupiter). */
export interface PriceGateway {
  /** mint → price in SOL. Mints with no available price are absent from the map. */
  getPricesSol(mints: string[]): Promise<Map<string, number>>;
  /** SOL's own spot price in USD — for the few USD figures we surface (e.g. share cards). Null if unavailable. */
  getSolUsd(): Promise<number | null>;
}

/** Display metadata for a token mint (symbol + optional icon URL). */
export interface TokenMeta {
  symbol: string;
  icon?: string;
}

/** Resolves token display metadata by mint (DAS/Jupiter), mint-keyed so it dedups across users. */
export interface TokenMetadataGateway {
  /** mint → metadata. Every requested mint is present (unknown mints get a short-address fallback symbol). */
  resolve(mints: string[]): Promise<Map<string, TokenMeta>>;
}

/** Reads positions from Meteora (REST). All methods paginate fully. */
export interface PositionsGateway {
  listOpenPools(wallet: string): Promise<PoolRef[]>;
  listClosedPools(wallet: string, daysBack: number): Promise<PoolRef[]>;
  fetchOpenPositions(wallet: string, pool: PoolRef): Promise<OpenPosition[]>;
  fetchClosedPositions(wallet: string, pool: PoolRef): Promise<ClosedPosition[]>;
}

/** Subscribes to on-chain DLMM activity for a wallet (Solana WS logsSubscribe). */
export interface RpcSubscriber {
  /** (re)subscribe a wallet; onActivity fires when a DLMM tx touches it. */
  watch(wallet: string, onActivity: (signature: string, instruction: string) => void): void;
  unwatch(wallet: string): void;
  isConnected(): boolean;
  /** fires on every (re)connect so the engine can trigger an immediate poll. */
  onReconnect(cb: () => void): void;
  onConnectionChange(cb: (connected: boolean) => void): void;
  start(): void;
  stop(): void;
}

/** Persists positions and sync state (SQLite). Upserts are idempotent. */
export interface PositionRepository {
  upsertClosed(positions: ClosedPosition[]): Promise<void>;
  /** replace the full open set for a wallet (positions absent are no longer open). */
  replaceOpenForWallet(wallet: string, positions: OpenPosition[]): Promise<void>;
  getOpen(wallet: string): Promise<OpenPosition[]>;
  getClosed(
    wallets: string[],
    opts: {
      page: number;
      pageSize: number;
      q?: string;
      sort?: 'recent' | 'pnl' | 'fees' | 'duration';
      dir?: 'asc' | 'desc';
      result?: 'all' | 'win' | 'loss';
    },
  ): Promise<{
    rows: ClosedPosition[];
    total: number;
  }>;
  /** Aggregate closed-position analytics entirely in SQL (no full-row transfer). `sinceMs` windows by
   *  closed_at; returns the Stats DTO minus `scope` (the route supplies it). Scales to large histories. */
  statsAggregate(wallets: string[], sinceMs: number): Promise<Omit<Stats, 'scope'>>;
  /** Realized PnL per time bucket via SQL GROUP BY (floor(closed_at / bucketMs)) — all-time, ascending.
   *  The caller fills gaps + the running cumulative; only the (few hundred) buckets cross the wire. */
  profitBuckets(wallets: string[], bucketMs: number): Promise<{ t: number; realized: number }[]>;
  /** Pools of positions stuck in 'pending_close' (disappeared from open, close not yet captured). */
  pendingClosePools(wallet: string): Promise<PoolRef[]>;
  /** Closed positions to rebuild on-chain. Default: only Meteora-unpriceable (pnl=0); `all` = every one. */
  onchainCandidates(
    wallet: string,
    opts?: { all?: boolean },
  ): Promise<{ positionAddress: string; mint: string; closedAt: number }[]>;
  /** Overwrite the authoritative closed PnL (residual revalued at the real on-chain sell proceeds) for
   *  one position, bypassing the settle-freeze — a deliberate enrichment, not a pool-price resync. */
  setAuthoritativePnl(positionAddress: string, pnlSol: number): Promise<void>;
  /** Same as setAuthoritativePnl for many positions at once, in ONE atomic statement (engine batch). */
  setAuthoritativePnlMany(byPosition: Map<string, number>): Promise<void>;
  /** status + closedAt for EVERY position (open + closed) of a wallet, keyed by address. The realized-PnL
   *  FIFO needs open positions too (their deposits consume token inventory), but reports only closed ones. */
  positionStatusForWallet(
    wallet: string,
  ): Promise<Map<string, { status: string; closedAt: number | null }>>;
  /** A single closed position by address (deep-links a position drawer from the URL). Null if not a closed position. */
  getClosedByAddress(positionAddress: string): Promise<ClosedPosition | null>;
  /** The wallet that owns a position (open OR closed), by address. Null if unknown — used to scope the
   *  per-position routes (bins/history) to the caller's watchlist. */
  walletOfPosition(positionAddress: string): Promise<string | null>;
  /** Persist a position's strategy family (decoded once from its on-chain open tx; immutable). */
  setStrategy(positionAddress: string, family: StrategyFamily): Promise<void>;
  /** Positions with a known strategy → family. Scoped to `wallet` when given (the hot per-sync path);
   *  no arg = every wallet (seeds the StrategyService cache on boot). */
  getStrategies(wallet?: string): Promise<Map<string, StrategyFamily>>;
  /** Closed positions whose strategy hasn't been resolved yet — for the background backfill. */
  addressesMissingStrategy(limit: number): Promise<string[]>;
}

/** Stores wallets, runtime settings and notification rules. */
export interface ConfigRepository {
  /** Load the in-memory caches (settings, rules) and seed defaults. Call once before use. */
  init(): Promise<void>;
  getSettings(): RuntimeSettings;
  saveSettings(s: Partial<RuntimeSettings>): Promise<RuntimeSettings>;
  listNotifRules(): NotifRule[];
  saveNotifRule(rule: NotifRule): Promise<void>;
}

/** A public-web account (or the seeded owner). */
export interface AccountUser {
  id: string;
  /** The Solana wallet address = identity / username. */
  address: string;
  isOwner: boolean;
  /** JWT generation counter; bumped on password reset to kill existing sessions. */
  tokenVersion: number;
}

/** One wallet on a user's watchlist. */
export interface WatchedWallet {
  address: string;
  label: string;
  color?: string;
  createdAt: number;
}

export interface WhitelistEntry {
  address: string;
  note: string;
  addedBy: string;
  createdAt: number;
}

export interface AccountSummary {
  id: string;
  address: string;
  isOwner: boolean;
  createdAt: number;
  /** The wallets this account watches (the registration address first). */
  wallets: string[];
}

// AccessEntry + WalletOverview are the api→web admin contract — canonical in @binsight/shared.
// Re-exported here so existing `@/domain/ports` importers keep their import path.
export type { AccessEntry, WalletOverview };

/** Users and their per-account wallet watchlists — the multi-tenant boundary. */
/** What a signature nonce is for — binds a challenge to its intended action. */
export type NoncePurpose = 'register' | 'reset';

export interface AccountRepository {
  /** Seed the owner allowlist entry (OWNER_ADDRESS) so the owner can register the bootstrap account. */
  init(ownerAddress: string): Promise<void>;
  createUser(p: { address: string; passwordHash: string; isOwner: boolean }): Promise<AccountUser>;
  findByAddress(address: string): Promise<{ user: AccountUser; passwordHash: string } | null>;
  findById(id: string): Promise<AccountUser | null>;
  /** The account for `id` only if its `jti` session is still valid — one JOIN for the auth hot path. */
  findByIdWithSession(id: string, jti: string): Promise<AccountUser | null>;
  /** Replace a user's password hash AND bump tokenVersion (invalidates existing sessions). */
  resetPassword(id: string, passwordHash: string): Promise<void>;

  // ── Whitelist (owner-managed registration gate) ──
  isWhitelisted(address: string): Promise<boolean>;
  listWhitelist(): Promise<WhitelistEntry[]>;
  addWhitelist(p: { address: string; note?: string; addedBy?: string }): Promise<void>;
  removeWhitelist(address: string): Promise<void>;

  // ── Signature nonces (single-use, purpose-bound) ──
  issueNonce(
    address: string,
    nonce: string,
    expiresAt: number,
    purpose: NoncePurpose,
  ): Promise<void>;
  /** Atomically consume a nonce for an (address, purpose): true iff it existed, matched the purpose,
   *  and was unexpired. The purpose binding stops a register challenge being used to reset (or vice versa). */
  consumeNonce(address: string, nonce: string, purpose: NoncePurpose): Promise<boolean>;

  // ── Session allowlist (one row per issued JWT jti) for real logout + revocation ──
  createSession(jti: string, userId: string, expiresAt: number): Promise<void>;
  /** True iff `jti` is a known, unexpired session — the per-request auth gate. */
  isSessionValid(jti: string): Promise<boolean>;
  /** Revoke one session (logout). */
  deleteSession(jti: string): Promise<void>;
  /** Revoke ALL of a user's sessions (on password reset). */
  deleteUserSessions(userId: string): Promise<void>;

  // ── Admin: accounts ──
  listAccounts(): Promise<AccountSummary[]>;
  /** Unified admin access list (invited + joined, merged by address). */
  listAccess(): Promise<AccessEntry[]>;
  /** Per-monitored-wallet operational stats for the admin Wallets tab. */
  walletOverview(): Promise<WalletOverview[]>;
  /** Delete an account + its watchlist + its sessions; returns the wallets left with no watcher (engine
   *  stops LIVE monitoring them). Shared position/flow data is KEPT (keyed by address), never evicted. */
  deleteAccount(id: string): Promise<string[]>;

  /** Distinct wallet addresses watched by anyone — the engine's monitored set. */
  monitoredWallets(): Promise<string[]>;
  watchedBy(userId: string): Promise<WatchedWallet[]>;
  watchedAddresses(userId: string): Promise<string[]>;
  countWatched(userId: string): Promise<number>;
  isWatching(userId: string, address: string): Promise<boolean>;
  /** Add a wallet to a user's watchlist. Idempotent. */
  addWatch(userId: string, w: { address: string; label?: string; color?: string }): Promise<void>;
  /** Remove from a user's watchlist; returns the remaining watcher count for that wallet. */
  removeWatch(userId: string, address: string): Promise<number>;
}

/** A delivery channel for notifications. */
export interface NotificationChannel {
  readonly name: string;
  deliver(event: LiveEvent): Promise<void>;
}

/** Sinks per-source success/failure so the engine can report a real, per-service health status. */
export interface HealthReporter {
  record(source: string, ok: boolean, detail?: string): void;
}

/** Persists decoded DLMM legs + pool metadata + the per-wallet ingest cursor (the on-chain history store). */
export interface LegRepository {
  /** Idempotently replace the legs of a set of signatures (delete-then-insert) — safe to re-run. */
  replaceForSignatures(wallet: string, signatures: string[], legs: DlmmLeg[]): Promise<void>;
  legsByPosition(position: string): Promise<StoredLeg[]>;
  legsByWallet(wallet: string): Promise<StoredLeg[]>;
  /** Legs for a SUBSET of positions (the open set) — the cheap cadence-refresh path. */
  legsByPositions(positions: string[]): Promise<StoredLeg[]>;
  /** Cached metadata for a set of pools (immutable on-chain; populated lazily). */
  getPoolMetas(pools: string[]): Promise<Map<string, LoadedPoolMeta>>;
  /** Persist a pool's decoded metadata (idempotent; immutable so a re-write is a no-op). */
  putPoolMeta(pool: string, meta: LoadedPoolMeta): Promise<void>;
  getCursor(wallet: string): Promise<IngestCursor | null>;
  setCursor(wallet: string, cursor: IngestCursor): Promise<void>;
}

/** Persists the wallet cash-flow that backs the wallet PnL curve (raw flows + daily rollup + cursor). */
export interface WalletFlowRepository {
  /** Idempotently store paged flows (PK wallet,signature) and maintain the daily rollup atomically. */
  upsertFlows(wallet: string, flows: WalletFlowRow[]): Promise<void>;
  /** The daily flow series for one or more wallets since `sinceSec`, summed in SQL by UTC day. */
  dailyFlows(wallets: string[], sinceSec: number): Promise<DailyFlow[]>;
  /** The reconstructed on-chain cash balance = signed sum of every persisted flow (native + wSOL).
   *  Backs the Net Worth reconciliation invariant (ledger vs live on-chain idle). */
  reconstructedSum(wallet: string): Promise<number>;
  /** Authoritatively rebuild the daily rollup from the raw flows (idempotent boot repair). */
  rebuildDaily(): Promise<void>;
  /** Resync the rollup from raw on boot (always rebuilds — authoritative + idempotent). */
  ensureDailyBackfilled(): Promise<void>;
  getCursor(wallet: string): Promise<FlowCursor | null>;
  setCursor(wallet: string, cursor: FlowCursor): Promise<void>;
  /** True iff every wallet has a complete cursor (one COUNT query, not N point-lookups). */
  allCursorsComplete(wallets: string[]): Promise<boolean>;
}

/** 100%-on-chain DLMM wallet snapshot + per-position bins/history reader (Solana RPC). */
/** A presence signal the notification manager reads (is any client actively viewing right now?). */
export interface PresenceReader {
  isAnyClientActive(): boolean;
}

export interface OnchainDlmmGateway {
  /** Per-bin liquidity distribution of one open position (Price-Bin histogram). */
  positionBins(positionAddress: string): Promise<PositionBins | null>;
  /** On-chain event timeline of a position (History drawer). */
  positionHistory(positionAddress: string): Promise<PositionHistory | null>;
  /** Token decimals for a mint (cached) — needed to scale residual amounts for valuation. */
  decimalsOf(mint: string): Promise<number>;
  /** Pinned-slot snapshot of a wallet's positions + idle balances; returns the reusable discovery plan. */
  snapshotWallet(
    ownerStr: string,
    cachedPlan?: SnapshotPlan,
  ): Promise<OnchainWalletSnapshot & { plan: SnapshotPlan }>;
}

/** Ingests a wallet's full Meteora DLMM history from chain into the LegRepository (resumable). */
export interface DlmmIngest {
  ingest(
    wallet: string,
    opts?: { onProgress?: (txs: number) => void; maxPages?: number },
  ): Promise<{ legs: number; txs: number; complete: boolean }>;
}

/** Reads a wallet's parsed txs from the Helius Enhanced API (realized sells + persisted cash-flow). */
export interface EnhancedTxGateway {
  /** Enabled only when the Helius URL carries an api-key (the Enhanced API needs one). */
  readonly enabled: boolean;
  /** All clean token→SOL sells since `sinceMs`; `complete` is false when history wasn't fully traversed. */
  fetchSells(
    wallet: string,
    sinceMs: number,
  ): Promise<{ sells: ResidualSell[]; complete: boolean; oldestTs: number }>;
  /** All clean SOL→token buys since `sinceMs` (ResidualSell shape, solReceived = SOL SPENT) — the real
   *  entry cost of pre-bought deposited tokens, for the chained-FIFO realized-PnL engine. */
  fetchBuys(
    wallet: string,
    sinceMs: number,
  ): Promise<{ buys: ResidualSell[]; complete: boolean; oldestTs: number }>;
  /** Page a wallet's full tx stream for PERSISTENCE, handing each page to `onPage` (incremental). */
  pageFlows(
    wallet: string,
    opts: {
      untilSig?: string | null;
      startBefore?: string | null;
      onPage: (flows: WalletFlowRow[]) => Promise<void>;
    },
  ): Promise<{
    added: number;
    complete: boolean;
    /** top-up only: the run reached the previously-ingested top signature (no gap left behind). */
    hitKnownTop: boolean;
    newestSig: string | null;
    oldestSig: string | null;
  }>;
}

/** Resolves a position's strategy family (Spot/Curve/BidAsk) once from its on-chain open transaction. */
export interface StrategyResolver {
  resolve(positionAddress: string): Promise<StrategyFamily | null>;
}

/** Reads (decodes) a DLMM pool's immutable metadata from chain — the injectable side of pool-meta. */
export interface PoolMetaReader {
  /** Decode the LbPair account for `pool`; null if missing/undecodable or no SOL side resolved. */
  loadPoolMeta(pool: string): Promise<LoadedPoolMeta | null>;
}
