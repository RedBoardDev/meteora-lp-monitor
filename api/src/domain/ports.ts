import type {
  ClosedPosition,
  LiveEvent,
  NotifRule,
  OpenPosition,
  RuntimeSettings,
} from '@meteora/shared';

/** A pool the wallet has positions in. */
export interface PoolRef {
  poolAddress: string;
  tokenX: string;
  tokenY: string;
  tokenXMint: string;
  tokenYMint: string;
}

/** Token spot prices in SOL via an aggregator (Jupiter). */
export interface PriceGateway {
  /** mint → price in SOL. Mints with no available price are absent from the map. */
  getPricesSol(mints: string[]): Promise<Map<string, number>>;
}

/** Reads positions from Meteora (REST). All methods paginate fully. */
export interface PositionsGateway {
  listOpenPools(wallet: string): Promise<PoolRef[]>;
  listClosedPools(wallet: string, daysBack: number): Promise<PoolRef[]>;
  fetchOpenPositions(wallet: string, pool: PoolRef): Promise<OpenPosition[]>;
  fetchClosedPositions(wallet: string, pool: PoolRef): Promise<ClosedPosition[]>;
}

/** Reads a wallet's idle capital (native SOL + wSOL + stables) in SOL, via RPC + Jupiter. */
export interface BalanceGateway {
  getIdleSol(wallet: string): Promise<number>;
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
  upsertClosed(positions: ClosedPosition[]): void;
  /** replace the full open set for a wallet (positions absent are no longer open). */
  replaceOpenForWallet(wallet: string, positions: OpenPosition[]): void;
  getOpen(wallet: string): OpenPosition[];
  getClosed(
    wallet: string,
    opts: { page: number; pageSize: number },
  ): {
    rows: ClosedPosition[];
    total: number;
  };
  /** All closed positions for a scope ("all" or a wallet), chronological — for stats. */
  getClosedForStats(scope: string): ClosedPosition[];
  /** Pools of positions stuck in 'pending_close' (disappeared from open, close not yet captured). */
  pendingClosePools(wallet: string): PoolRef[];
  /** Addresses of every already-persisted closed position — used to seed the engine's
   *  "already notified" set on boot so a restart never re-alerts a known close. */
  closedAddresses(): string[];
  /** Overwrite the authoritative closed PnL (LPAgent's market valuation) for one position,
   *  bypassing the settle-freeze — this is a deliberate enrichment, not a pool-price resync. */
  setAuthoritativePnl(positionAddress: string, pnlSol: number): void;
  getSyncState(wallet: string): { lastFullSyncAt: number | null; lastClosedTs: number | null };
  setSyncState(wallet: string, state: { lastFullSyncAt: number; lastClosedTs: number }): void;
}

/** Stores wallets, runtime settings and notification rules. */
export interface ConfigRepository {
  listWallets(): { address: string; label: string; color?: string; createdAt: number }[];
  addWallet(w: { address: string; label: string; color?: string }): void;
  removeWallet(address: string): void;
  getSettings(): RuntimeSettings;
  saveSettings(s: Partial<RuntimeSettings>): RuntimeSettings;
  listNotifRules(): NotifRule[];
  saveNotifRule(rule: NotifRule): void;
}

/** A delivery channel for notifications. */
export interface NotificationChannel {
  readonly name: string;
  deliver(event: LiveEvent): Promise<void>;
}

export interface Clock {
  now(): number;
}
