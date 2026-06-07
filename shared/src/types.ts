import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────────────
 * Wallets
 * ──────────────────────────────────────────────────────────────────────── */

export const WalletSchema = z.object({
  address: z.string().min(32).max(44),
  label: z.string().default(''),
  color: z.string().optional(),
  createdAt: z.number().int(),
});
export type Wallet = z.infer<typeof WalletSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * Positions
 * ──────────────────────────────────────────────────────────────────────── */

export const RangeStatusSchema = z.enum(['in', 'out_up', 'out_down', 'unknown']);
export type RangeStatus = z.infer<typeof RangeStatusSchema>;

/** An open position (live, mark-to-market in SOL). */
export const OpenPositionSchema = z.object({
  positionAddress: z.string(),
  wallet: z.string(),
  poolAddress: z.string(),
  tokenX: z.string(),
  tokenY: z.string(),
  tokenXMint: z.string(),
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
  pnlSol: z.number(),
  pnlPctSol: z.number(),
  feesSol: z.number(),
  depositSol: z.number(),
  withdrawSol: z.number(),
  openedAt: z.number().int().nullable(),
  closedAt: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
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

export const WalletStateSchema = z.object({
  /** wallet address, or "all" for the aggregated view. */
  scope: z.string(),
  totals: PortfolioTotalsSchema,
  openPositions: z.array(OpenPositionSchema),
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

export const HealthSchema = z.object({
  ok: z.boolean(),
  wsConnected: z.boolean(),
  meteoraOk: z.boolean(),
  effectiveRps: z.number(),
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
  avgDurationSeconds: z.number(),
  /** cumulative realized PnL over time (one point per closed position, chronological). */
  cumulativePnl: z.array(z.object({ t: z.number().int(), pnl: z.number() })),
  /** PnL aggregated by pair, best→worst. */
  byPair: z.array(z.object({ pair: z.string(), pnlSol: z.number(), count: z.number().int() })),
});
export type Stats = z.infer<typeof StatsSchema>;

/* ────────────────────────────────────────────────────────────────────────
 * WebSocket protocol (server ↔ client)
 * ──────────────────────────────────────────────────────────────────────── */

/** Server → client messages. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), payload: WalletStateSchema }),
  z.object({ type: z.literal('event'), payload: LiveEventSchema }),
  z.object({ type: z.literal('health'), payload: HealthSchema }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Client → server messages. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), scope: z.string() }),
  z.object({
    type: z.literal('presence'),
    device: z.enum(['mac', 'ios', 'web']),
    active: z.boolean(),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
