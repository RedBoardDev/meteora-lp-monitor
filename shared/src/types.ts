import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────
 * Wallets
 * ──────────────────────────────────────────────────────────────────────── */

export const WalletSchema = z.object({
  address: z.string().min(32).max(44),
  label: z.string().max(64).default(''),
  color: z.string().max(32).optional(),
  createdAt: z.number().int(),
  /** onboarding status (server-enriched): false while the wallet's history is still being indexed
   *  (a brand-new wallet's backfill). Absent on write payloads. */
  ready: z.boolean().optional(),
  /** txs ingested so far during the initial backfill — for an "indexing… (N txs)" UI state. */
  indexedTxs: z.number().int().optional(),
});
export type Wallet = z.infer<typeof WalletSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Positions
 * ──────────────────────────────────────────────────────────────────────── */

export const RangeStatusSchema = z.enum(['in', 'out_up', 'out_down', 'unknown']);
export type RangeStatus = z.infer<typeof RangeStatusSchema>;

/** Liquidity-shape family chosen at open (decoded once from the on-chain add-liquidity instruction). */
export const StrategyFamilySchema = z.enum(['Spot', 'Curve', 'BidAsk']);
export type StrategyFamily = z.infer<typeof StrategyFamilySchema>;

/** An open position (live, mark-to-market in SOL). */
export const OpenPositionSchema = z.object({
  positionAddress: z.string(),
  wallet: z.string(),
  poolAddress: z.string(),
  tokenX: z.string(),
  tokenY: z.string(),
  tokenXMint: z.string(),
  tokenXIcon: z.string().optional(),
  tokenYIcon: z.string().optional(),
  strategy: StrategyFamilySchema.nullable().default(null),
  sizeSol: z.number(), // current value (unrealizedPnl.balancesSol)
  pnlSol: z.number(),
  pnlPctSol: z.number(),
  claimedFeesSol: z.number(),
  unclaimedFeesSol: z.number(),
  rangeStatus: RangeStatusSchema,
  minPrice: z.number(),
  maxPrice: z.number(),
  poolPrice: z.number().nullable(),
  /** epoch ms when the position first went out-of-range (for duration alerts). */
  outOfRangeSince: z.number().int().nullable(),
  openedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
  // Non-SOL token currently held (from unrealizedPnl) — transient, used to revalue pnl/size at the
  // live market price. Not persisted.
  holdMint: z.string().optional(),
  holdAmount: z.number().optional(),
  holdMarkSol: z.number().optional(),
});
export type OpenPosition = z.infer<typeof OpenPositionSchema>;

/** A closed position (realized PnL in SOL, validated == on-chain). */
export const ClosedPositionSchema = z.object({
  positionAddress: z.string(),
  wallet: z.string(),
  poolAddress: z.string(),
  tokenX: z.string(),
  tokenY: z.string(),
  tokenXMint: z.string(),
  tokenXIcon: z.string().optional(),
  tokenYIcon: z.string().optional(),
  strategy: StrategyFamilySchema.nullable().default(null),
  pnlSol: z.number(),
  pnlPctSol: z.number(),
  feesSol: z.number(),
  depositSol: z.number(),
  withdrawSol: z.number(),
  openedAt: z.number().int().nullable(),
  closedAt: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  // DLMM bin range (base price in SOL) — drives the position chart's range band. Optional: absent on
  // very old rows predating range capture.
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  // Residual (non-SOL) token left at close — used to revalue PnL at the market price.
  // Transient on capture (not persisted); `pnlSol` already reflects the chosen source.
  residualMint: z.string().optional(),
  residualAmount: z.number().optional(),
  residualMarkSol: z.number().optional(),
  // 'market' = residual revalued at the live Jupiter price (fresh close); 'pool' = Meteora spot.
  pnlSource: z.enum(['pool', 'market']).optional(),
});
export type ClosedPosition = z.infer<typeof ClosedPositionSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Position detail — per-bin liquidity (Price-Bin histogram)
 * ──────────────────────────────────────────────────────────────────────── */

/** One price bin of a position: its price and the (UI) token amounts held there. */
export const PositionBinSchema = z.object({
  binId: z.number().int(),
  /** price of token X in token Y (UI units). */
  price: z.number(),
  amountX: z.number(),
  amountY: z.number(),
});
export type PositionBin = z.infer<typeof PositionBinSchema>;

/** Per-bin liquidity distribution of one OPEN position at a single slot. */
export const PositionBinsSchema = z.object({
  slot: z.number().int(),
  activeBinId: z.number().int(),
  binStep: z.number().int(),
  tokenXMint: z.string(),
  tokenYMint: z.string(),
  bins: z.array(PositionBinSchema),
});
export type PositionBins = z.infer<typeof PositionBinsSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Position history — on-chain event timeline (reconstructed via Helius)
 * ──────────────────────────────────────────────────────────────────────── */

export const PositionEventKindSchema = z.enum(['open', 'deposit', 'withdraw', 'claim', 'close']);
export type PositionEventKind = z.infer<typeof PositionEventKindSchema>;

/** One lifecycle event of a position, decoded from its on-chain transaction history. */
export const PositionEventSchema = z.object({
  kind: PositionEventKindSchema,
  /** epoch ms (block time of the transaction). */
  at: z.number().int(),
  signature: z.string(),
  /** UI amount of token X moved by this event (0 when none). */
  amountX: z.number(),
  /** UI amount of token Y moved by this event (0 when none). */
  amountY: z.number(),
});
export type PositionEvent = z.infer<typeof PositionEventSchema>;

/** Full event timeline of a position (oldest → newest), reconstructed from chain. */
export const PositionHistorySchema = z.object({
  positionAddress: z.string(),
  tokenXMint: z.string(),
  tokenYMint: z.string(),
  events: z.array(PositionEventSchema),
});
export type PositionHistory = z.infer<typeof PositionHistorySchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Aggregated wallet/portfolio state (REST + WS snapshot)
 * ──────────────────────────────────────────────────────────────────────── */

export const PortfolioTotalsSchema = z.object({
  uPnlSol: z.number(),
  uPnlPct: z.number(),
  feesSol: z.number(),
  claimedFeesSol: z.number(),
  unclaimedFeesSol: z.number(),
  tvlSol: z.number(),
  /** Idle wallet capital in SOL: native SOL + wSOL + stables (USDC/USDT) converted. */
  idleSol: z.number(),
  /** Grand total: tvlSol + idleSol. */
  walletTotalSol: z.number(),
  openCount: z.number().int(),
  inRangeCount: z.number().int(),
  outOfRangeCount: z.number().int(),
});
export type PortfolioTotals = z.infer<typeof PortfolioTotalsSchema>;

/** How trustworthy the headline total is right now. `syncing` = no on-chain snapshot yet, or a
 *  multi-slot read on a large wallet (bounded skew); `fresh` = a clean single-slot snapshot. */
export const FreshnessSchema = z.enum(['fresh', 'syncing', 'stale']);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const WalletStateSchema = z.object({
  /** wallet address, or "all" for the aggregated view. */
  scope: z.string(),
  totals: PortfolioTotalsSchema,
  openPositions: z.array(OpenPositionSchema),
  /** Solana slot the on-chain total is anchored to (null before the first snapshot). */
  asOfSlot: z.number().int().nullable().default(null),
  freshness: FreshnessSchema.default('syncing'),
  updatedAt: z.number().int(),
});
export type WalletState = z.infer<typeof WalletStateSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Engine / sync health
 * ──────────────────────────────────────────────────────────────────────── */

export const WalletHealthSchema = z.object({
  wallet: z.string(),
  wsConnected: z.boolean(),
  lastPollAt: z.number().int().nullable(),
  lastPollOk: z.boolean(),
  pollIntervalMs: z.number().int(),
  syncing: z.boolean(),
  syncProgress: z.number().min(0).max(1).nullable(),
});
export type WalletHealth = z.infer<typeof WalletHealthSchema>;

/** Per-source health for the live status indicator (hover → per-service detail). */
export const SourceStatusSchema = z.enum(['ok', 'lagging', 'down']);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const SourceHealthSchema = z.object({
  /** rpc | meteora | jupiter | ws */
  name: z.string(),
  status: SourceStatusSchema,
  lastOkAt: z.number().int().nullable(),
  lastErrorAt: z.number().int().nullable(),
  consecutiveErrors: z.number().int(),
  /** human-readable reason when not ok (e.g. "RPC 429", "disconnected"). */
  detail: z.string().nullable(),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const HealthSchema = z.object({
  ok: z.boolean(),
  wsConnected: z.boolean(),
  meteoraOk: z.boolean(),
  effectiveRps: z.number(),
  /** latest Solana slot the engine has observed (for indexer-lag display). */
  chainTipSlot: z.number().int().nullable().default(null),
  /** per-source breakdown the client renders on hover. */
  sources: z.array(SourceHealthSchema).default([]),
  wallets: z.array(WalletHealthSchema),
  uptimeSeconds: z.number(),
});
export type Health = z.infer<typeof HealthSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Notification events
 * ──────────────────────────────────────────────────────────────────────── */

export const EventKindSchema = z.enum([
  'position_open',
  'position_close',
  'oor_enter',
  'oor_duration',
  'oor_return',
  'pnl_threshold',
  'fees_threshold',
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const LiveEventSchema = z.object({
  id: z.string(),
  kind: EventKindSchema,
  wallet: z.string().nullable(),
  positionAddress: z.string().nullable(),
  pair: z.string().nullable(),
  /** human-ready title/body the clients can show directly. */
  title: z.string(),
  body: z.string(),
  /** structured numbers for rich rendering (pnlSol, feesSol, side, minutes...). */
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: z.number().int(),
});
export type LiveEvent = z.infer<typeof LiveEventSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Notification configuration (per event kind, global or per-wallet)
 * ──────────────────────────────────────────────────────────────────────── */

export const NotifModeSchema = z.enum(['single', 'bulk']);
export type NotifMode = z.infer<typeof NotifModeSchema>;

export const NotifRuleSchema = z.object({
  wallet: z.string().nullable(), // null = global default
  eventKind: EventKindSchema,
  enabled: z.boolean(),
  mode: NotifModeSchema,
  /** threshold in SOL or % depending on the kind (pnl_threshold/fees_threshold). */
  threshold: z.number().nullable(),
  /** for oor_duration: minutes out-of-range before alerting. */
  oorMinutes: z.number().int().nullable(),
});
export type NotifRule = z.infer<typeof NotifRuleSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Runtime settings (overridable from the Settings page)
 * ──────────────────────────────────────────────────────────────────────── */

export const RuntimeSettingsSchema = z.object({
  meteoraTargetRps: z.number().positive(),
  pollMinMs: z.number().int().positive(),
  pollMaxMs: z.number().int().positive(),
  pollIdleMs: z.number().int().positive(),
  barkKey: z.string(),
  presenceTimeoutSeconds: z.number().int().positive(),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Stats / analytics
 * ──────────────────────────────────────────────────────────────────────── */

export const StatsSchema = z.object({
  scope: z.string(),
  closedCount: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  winRate: z.number(),
  totalPnlSol: z.number(),
  todayPnlSol: z.number(),
  totalFeesSol: z.number(),
  totalVolumeSol: z.number(),
  /** mean deposit per closed position. */
  avgInvestedSol: z.number(),
  /** total realized PnL ÷ months spanned by the closed history. */
  avgMonthlyProfitSol: z.number(),
  /** mean realized PnL per closed position (expected value of a position). */
  expectedValueSol: z.number(),
  /** gross profit ÷ gross loss (>1 = a net-profitable system); 0 when there are no losing trades. */
  profitFactor: z.number(),
  avgDurationSeconds: z.number(),
  /** PnL aggregated by pair, best→worst. */
  byPair: z.array(z.object({ pair: z.string(), pnlSol: z.number(), count: z.number().int() })),
});
export type Stats = z.infer<typeof StatsSchema>;

/** Time bucket for the profit-history chart. */
export const BucketSchema = z.enum(['hour', 'day', 'week', 'month']);
export type Bucket = z.infer<typeof BucketSchema>;

/** One bar of the profit-history chart: realized PnL in the bucket + all-time running total. */
export const ProfitBucketSchema = z.object({
  t: z.number().int(),
  realized: z.number(),
  cumulative: z.number(),
});
export type ProfitBucket = z.infer<typeof ProfitBucketSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * WebSocket protocol (server ↔ client)
 * ──────────────────────────────────────────────────────────────────────── */

// Server → client messages are produced by the server directly and consumed by a trusted first-party
// client, so they carry no runtime schema. Inbound client → server messages ARE validated below.

/** Client → server messages. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), scope: z.string() }),
  z.object({
    type: z.literal('presence'),
    device: z.enum(['mac', 'web']),
    active: z.boolean(),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Admin DTOs (owner-only views) — server-produced, no runtime schema
 * ──────────────────────────────────────────────────────────────────────── */

/** One row of the unified admin access view (whitelist invites + registered accounts, merged by address). */
export interface AccessEntry {
  address: string;
  status: 'invited' | 'joined';
  isOwner: boolean;
  note: string;
  /** Wallets this account watches (empty for an invited-but-not-yet-joined address). */
  wallets: string[];
  createdAt: number;
}

/** One monitored wallet's operational stats for the admin Wallets tab. The repository produces the
 *  core fields; the `/admin/wallets` route enriches each row with live ingest status (`ready` /
 *  `indexedTxs`), so those are optional on the wire. */
export interface WalletOverview {
  address: string;
  /** Number of accounts currently watching this wallet (shared monitoring; data loaded once). */
  watchers: number;
  openPositions: number;
  closedPositions: number;
  /** Epoch ms of the last position sync for this wallet (null if never synced). */
  lastUpdate: number | null;
  /** Live ingest status (route-enriched): false while the wallet's history is still being indexed. */
  ready?: boolean;
  /** Txs ingested so far during the initial backfill. */
  indexedTxs?: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Wallet PnL curve (true realized SOL from on-chain cash-flow) — server DTO
 * ──────────────────────────────────────────────────────────────────────── */

/** One day of the wallet PnL cash-flow curve (the TRUE realized SOL, incl. rug/slippage losses). */
export interface WalletPnlDay {
  /** YYYY-MM-DD (UTC) */
  date: string;
  /** net trading SOL flow that day (the realized PnL increment). */
  tradingSol: number;
  /** net external SOL flow that day (funding / withdrawals — shown apart, not PnL). */
  externalSol: number;
  /** running cumulative trading SOL since the window start (the curve). */
  cumulativeSol: number;
  /** running cumulative of (trading+external) = reconstructed on-chain cash balance (reconciles with getBalance) */
  cumulativeTotalSol: number;
}

export interface WalletPnlCurve {
  /** the daily wallet PnL series (trading SOL flow, cumulative, external flow apart). */
  days: WalletPnlDay[];
  /** realized trading PnL over the window (= the final cumulative). */
  totalTradingSol: number;
  /** net external (CEX / non-trading) SOL movement over the window — shown apart, not PnL. */
  totalExternalSol: number;
  /** false if any requested wallet's on-chain history isn't fully ingested yet (curve still building). */
  complete: boolean;
}

/* ────────────────────────────────────────────────────────────────────────
 * Net Worth curve (forward-only TRUE on-chain wallet total over time) — server DTO
 * ──────────────────────────────────────────────────────────────────────── */

/** One reconstructed Net Worth + PnL point (per UTC day). */
export interface NetworthCurvePoint {
  /** YYYY-MM-DD (UTC). */
  date: string;
  /** The wallet VALUE at end of that day (cum_trading + cum_ext + deployed; ≥0 in practice; reconciles
   *  with the hero walletTotalSol). Falls to 0 if emptied — never negative. */
  networth: number;
  /** Cumulative net deposits (cum_ext = deposits − withdrawals) up to end of that day. */
  apports: number;
  /** The PERFORMANCE net of apports (= networth − apports = cum_trading + deployed). CAN be negative. */
  realPnl: number;
}

export interface NetworthCurve {
  points: NetworthCurvePoint[];
}

/* ────────────────────────────────────────────────────────────────────────
 * Position price chart — OHLCV candles (GeckoTerminal) — server DTO
 * ──────────────────────────────────────────────────────────────────────── */

/** One OHLC candle for the position price chart — bar-open time (unix seconds), price in SOL (the
 *  same unit as a position's range), volume in the base token. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
