/**
 * Copy-bot · observability — the central CODE_REGISTRY (PURE: no I/O, no SDK, no DB).
 *
 * ONE closed set of typed codes replacing the ~40 ad-hoc reason strings. Each leaf carries its category /
 * severity / audience and (for user-visible codes) its feed title + render template. `CopyCode` is the
 * resulting closed union — the discriminant of `CopyEvent` (SPEC §2).
 *
 * Leaf == the VERBATIM current journaled `reason` string (existing tests keep passing); the registry KEY may be
 * the clean canonical name where it differs, and `LEGACY_REASON_ALIASES` bridges the old reason → the clean
 * code (SPEC §2, §2.3). "Never translate an identifier" (project standard).
 */
import type { CopyAudience, CopyCategory, CopySeverity } from './event';

// ── Windows owned by the PURE layer ────────────────────────────────────────────────────────────────────────
// (The I/O-bound windows — durable-persist timeouts, outbox sweep cadence — arrive with the emitter in P1.)

/** In-process LRU TTL for `(correlationId, code)` dedup: collapses WS + cursor-poll double-detect to one row. */
export const EMIT_DEDUP_TTL_MS = 120_000; // 2 min — comfortably longer than a single detect→land lifecycle

/** Feed de-dup window for spammy "why no copy" codes (filter/cap) — under leader bursts, coalesce into one row. */
export const FEED_COALESCE_MS = 10_000; // 10 s — SPEC §0 D-8 / §6

/** Pinned (critical) codes are NEVER throttled — they must always reach the feed as a distinct alert (SPEC §6). */
export const PINNED_COALESCE_MS = 0;

/** Render template id in `render-user.ts`. REQUIRED on every `audience:'feed'` code; unused for internal codes. */
export type RenderKind =
  | 'open'
  | 'close'
  | 'partial-remove'
  | 'add'
  | 'claim'
  | 'swap'
  | 'swap-failed'
  | 'insufficient-balance'
  | 'skipped-filter'
  | 'skipped-cap'
  | 'skipped-sizing'
  | 'skipped-eligibility'
  | 'failsafe-activated'
  | 'failsafe-failed'
  | 'system-fatal';

export interface CodeMeta {
  category: CopyCategory;
  severity: CopySeverity;
  /** `'internal'` (admin-only) | `'feed'` (the user sees it). */
  audience: CopyAudience;
  /** Alert-in-feed + (future) external push. INVARIANT: pinned ⇒ audience:'feed' AND coalesceMs:0 (SPEC §2.2). */
  pinned?: boolean;
  /** REQUIRED when audience === 'feed'. */
  title?: string;
  /** REQUIRED when audience === 'feed' — selects the SOL-only template in render-user.ts. */
  render?: RenderKind;
  /** Feed de-dup window (0 = never; default 0; FEED_COALESCE_MS on spammy feed codes). */
  coalesceMs?: number;
}

/**
 * The complete registry. Every leaf from SPEC §2.1, with audience / pinned / coalesceMs exactly as the table
 * specifies. Producer-less leaves added per the design recommendations are marked `// FUTURE` (no emitter yet).
 *
 * Authored `as const satisfies Record<string, CodeMeta>` so it is BOTH a literal (→ `keyof typeof` is the closed
 * `CopyCode` union) AND compile-time checked entry-by-entry (a malformed meta is a build error — §2.2 test 1).
 * It is then re-exported widened to `Record<CopyCode, CodeMeta>` so reads yield a `CodeMeta` (optional fields
 * present), matching the SPEC's `CODE_REGISTRY[code]` usage.
 */
const RAW_CODE_REGISTRY = {
  // ── lifecycle (LIFECYCLE) — brain owns all *_confirmed / *_failed (only it has the Mirror) ─────────────────
  'lifecycle.open_published': { category: 'LIFECYCLE', severity: 'info', audience: 'internal' },
  'lifecycle.open_confirmed': { category: 'LIFECYCLE', severity: 'info', audience: 'feed', title: 'Opened DLMM Position', render: 'open' },
  'lifecycle.open_failed': { category: 'LIFECYCLE', severity: 'error', audience: 'feed', pinned: true, coalesceMs: PINNED_COALESCE_MS, title: 'Open Failed', render: 'failsafe-failed' },
  'lifecycle.add_confirmed': { category: 'LIFECYCLE', severity: 'info', audience: 'feed', title: 'Added Liquidity', render: 'add', coalesceMs: FEED_COALESCE_MS },
  'lifecycle.remove_partial': { category: 'LIFECYCLE', severity: 'info', audience: 'feed', title: 'Partially Removed', render: 'partial-remove' },
  'lifecycle.close_confirmed': { category: 'LIFECYCLE', severity: 'info', audience: 'feed', title: 'Closed DLMM Position', render: 'close' },
  'lifecycle.close_failed': { category: 'LIFECYCLE', severity: 'error', audience: 'feed', pinned: true, coalesceMs: PINNED_COALESCE_MS, title: 'Close Failed', render: 'failsafe-failed' },
  'lifecycle.claim_confirmed': { category: 'LIFECYCLE', severity: 'info', audience: 'feed', title: 'Claimed Fees', render: 'claim' },

  // ── detect (DETECT) — hot-path traces, admin-only ──────────────────────────────────────────────────────────
  'detect.observed': { category: 'DETECT', severity: 'info', audience: 'internal' },
  'detect.routed': { category: 'DETECT', severity: 'info', audience: 'internal' },
  'detect.snapshot_failed': { category: 'DETECT', severity: 'warn', audience: 'internal' },
  'detect.leader_position_not_found': { category: 'DETECT', severity: 'warn', audience: 'internal' },
  'detect.not_on_chain_yet': { category: 'DETECT', severity: 'info', audience: 'internal' },

  // ── filter (FILTER) — the 16 verbatim leaves + entry_filter rollup; feed (transparency), coalesce 10s ───────
  'filter.below_min_market_cap': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Market Cap Below Min', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.min_market_cap_unavailable': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Market Cap Unavailable', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.below_min_holders': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Holders Below Min', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.min_holders_unavailable': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Holders Unavailable', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.below_min_24h_volume': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — 24h Volume Below Min', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.min_24h_volume_unavailable': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — 24h Volume Unavailable', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.below_min_organic_score': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Organic Score Below Min', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.min_organic_score_unavailable': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Organic Score Unavailable', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.below_min_price_range': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Price Range Below Min', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.min_price_range_unavailable': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Price Range Unavailable', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.above_max_price_change': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Price Change Above Max', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.max_price_change_unavailable': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Price Change Unavailable', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.below_min_token_age': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Token Age Below Min', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.min_token_age_unavailable': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Token Age Unavailable', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.ignored_token': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Ignored Token', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  'filter.single_pool_per_token': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Already In This Token', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },
  // FUTURE: aggregate "an entry filter rejected this" rollup — no dedicated producer yet (rollup of the 16 above).
  'filter.entry_filter': { category: 'FILTER', severity: 'info', audience: 'feed', title: 'Skipped — Entry Filter', render: 'skipped-filter', coalesceMs: FEED_COALESCE_MS },

  // ── cap (CAP) — kill-switches internal; the user-relevant caps are feed ────────────────────────────────────
  'cap.kill_switch_global': { category: 'CAP', severity: 'warn', audience: 'internal' },
  'cap.kill_switch_leader': { category: 'CAP', severity: 'warn', audience: 'internal' },
  'cap.max_open_positions': { category: 'CAP', severity: 'warn', audience: 'feed', title: 'No Copy — Max Open Positions', render: 'skipped-cap', coalesceMs: FEED_COALESCE_MS },
  'cap.max_concurrent_per_token': { category: 'CAP', severity: 'warn', audience: 'feed', title: 'No Copy — Max Concurrent Per Token', render: 'skipped-cap', coalesceMs: FEED_COALESCE_MS },
  'cap.max_opens_per_window': { category: 'CAP', severity: 'warn', audience: 'feed', title: 'No Copy — Max Opens Per Window', render: 'skipped-cap', coalesceMs: FEED_COALESCE_MS },
  'cap.max_total_exposure': { category: 'CAP', severity: 'warn', audience: 'feed', title: 'No Copy — Max Total Exposure', render: 'skipped-cap', coalesceMs: FEED_COALESCE_MS },
  // FUTURE: skip an add because infinite-add is off — no dedicated producer yet. Uses the `add` template's
  // skipped-add branch (SPEC §3.2 `⏭️ Skipped Add — infinite-add off`), not the generic cap line.
  'cap.infinite_add_skipped': { category: 'CAP', severity: 'info', audience: 'feed', title: 'Skipped Add — Infinite-Add Off', render: 'add', coalesceMs: FEED_COALESCE_MS },

  // ── sizing / balance ───────────────────────────────────────────────────────────────────────────────────────
  'sizing.below_min_floor': { category: 'SIZING', severity: 'info', audience: 'feed', title: 'Skipped — Below Min Size Floor', render: 'skipped-sizing', coalesceMs: FEED_COALESCE_MS },
  // Balance line uses the CONFIGURED value, labelled (SPEC §0 D-2) — never claimed as the live wallet balance.
  'balance.insufficient': { category: 'BALANCE', severity: 'error', audience: 'feed', pinned: true, coalesceMs: PINNED_COALESCE_MS, title: 'Insufficient Balance', render: 'insufficient-balance' },

  // ── eligibility (ELIGIBILITY) — D-3 canonicalizes non_sol_pool → eligibility.non_sol_paired ────────────────
  'eligibility.non_sol_paired': { category: 'ELIGIBILITY', severity: 'info', audience: 'feed', title: 'Skipped — Non-SOL Pair', render: 'skipped-eligibility', coalesceMs: FEED_COALESCE_MS },
  'eligibility.token2022_deposit_failed': { category: 'ELIGIBILITY', severity: 'error', audience: 'feed', title: 'Skipped — Token-2022 Deposit Failed', render: 'skipped-eligibility' },
  'eligibility.twosided.unbuyable': { category: 'ELIGIBILITY', severity: 'info', audience: 'feed', title: 'Skipped — Token Unbuyable', render: 'skipped-eligibility', coalesceMs: FEED_COALESCE_MS },
  'eligibility.twosided.token2022_too_wide': { category: 'ELIGIBILITY', severity: 'info', audience: 'feed', title: 'Skipped — Token-2022 Range Too Wide', render: 'skipped-eligibility', coalesceMs: FEED_COALESCE_MS },

  // ── reshape (RESHAPE) — noop internal; the rest reach the user ─────────────────────────────────────────────
  'reshape.token_unbuyable': { category: 'RESHAPE', severity: 'info', audience: 'feed', title: 'Reshape Skipped — Token Unbuyable', render: 'skipped-eligibility', coalesceMs: FEED_COALESCE_MS },
  'reshape.partial_range': { category: 'RESHAPE', severity: 'warn', audience: 'internal' },
  'reshape.noop': { category: 'RESHAPE', severity: 'info', audience: 'internal' },
  'reshape.add_failed': { category: 'RESHAPE', severity: 'error', audience: 'feed', title: 'Reshape Add Failed', render: 'failsafe-failed' },

  // ── swap (SWAP) — residual/sweep internal; sell/executed/failed reach the user ─────────────────────────────
  'swap.no_residual': { category: 'SWAP', severity: 'info', audience: 'internal' },
  'swap.sweep_detected': { category: 'SWAP', severity: 'info', audience: 'internal' },
  'swap.sweep_build_error': { category: 'SWAP', severity: 'warn', audience: 'internal' },
  'swap.below_min_sell_out': { category: 'SWAP', severity: 'info', audience: 'feed', title: 'Skipped — Below Min Sell-Out', render: 'skipped-sizing', coalesceMs: FEED_COALESCE_MS },
  'swap.executed': { category: 'SWAP', severity: 'info', audience: 'feed', title: 'Swapped to SOL', render: 'swap' },
  'swap.failed_after_retries': { category: 'SWAP', severity: 'error', audience: 'feed', pinned: true, coalesceMs: PINNED_COALESCE_MS, title: 'Swap Failed', render: 'swap-failed' },

  // ── sign (SIGN, coffre Wall-A) — internal; the user sees the resulting lifecycle.*_failed, not these ───────
  'sign.bad_hmac_or_hop': { category: 'SIGN', severity: 'error', audience: 'internal' },
  'sign.bad_schema': { category: 'SIGN', severity: 'error', audience: 'internal' },
  'sign.stale': { category: 'SIGN', severity: 'warn', audience: 'internal' },
  'sign.commandId_mismatch': { category: 'SIGN', severity: 'error', audience: 'internal' },
  'sign.duplicate': { category: 'SIGN', severity: 'info', audience: 'internal' },
  'sign.over_max_trade': { category: 'SIGN', severity: 'error', audience: 'internal' },
  'sign.undecodable_tx': { category: 'SIGN', severity: 'error', audience: 'internal' },
  'sign.owner_mismatch': { category: 'SIGN', severity: 'error', audience: 'internal' },
  'sign.dry_run': { category: 'SIGN', severity: 'info', audience: 'internal' },
  'sign.landed': { category: 'SIGN', severity: 'info', audience: 'internal' },
  'sign.land_failed': { category: 'SIGN', severity: 'error', audience: 'internal' },

  // ── wallb (WALLB) — compromised-brain signal; internal (program_not_allowed carries `${prog}`→adminDetail) ─
  'wallb.signer_not_owner': { category: 'WALLB', severity: 'error', audience: 'internal' },
  'wallb.missing_position_signer': { category: 'WALLB', severity: 'error', audience: 'internal' },
  'wallb.pool_not_referenced': { category: 'WALLB', severity: 'error', audience: 'internal' },
  'wallb.foreign_sol_destination': { category: 'WALLB', severity: 'error', audience: 'internal' },
  'wallb.jito_tip_too_large': { category: 'WALLB', severity: 'error', audience: 'internal' },
  'wallb.swap_missing_token_mint': { category: 'WALLB', severity: 'error', audience: 'internal' },
  'wallb.swap_token_not_owner_ata': { category: 'WALLB', severity: 'error', audience: 'internal' },
  'wallb.sol_spend_over_cap': { category: 'WALLB', severity: 'error', audience: 'internal' },
  'wallb.program_not_allowed': { category: 'WALLB', severity: 'error', audience: 'internal' },

  // ── failsafe (FAILSAFE) — all reach the user, all pinned ───────────────────────────────────────────────────
  'failsafe.activated': { category: 'FAILSAFE', severity: 'warn', audience: 'feed', pinned: true, coalesceMs: PINNED_COALESCE_MS, title: 'Failsafe Activated', render: 'failsafe-activated' },
  'failsafe.failed': { category: 'FAILSAFE', severity: 'error', audience: 'feed', pinned: true, coalesceMs: PINNED_COALESCE_MS, title: 'Failsafe FAILED — close manually', render: 'failsafe-failed' },
  'failsafe.orphan_closed': { category: 'FAILSAFE', severity: 'warn', audience: 'feed', pinned: true, coalesceMs: PINNED_COALESCE_MS, title: 'Orphan Auto-Closed', render: 'failsafe-activated' },
  'failsafe.rug_sl_triggered': { category: 'FAILSAFE', severity: 'warn', audience: 'feed', pinned: true, coalesceMs: PINNED_COALESCE_MS, title: 'Rug Stop-Loss Triggered', render: 'failsafe-activated' },

  // ── system (SYSTEM) — internal except `fatal`=feed; self-failures NEVER user-notify (loop guard, SPEC §6) ──
  'system.config_missing': { category: 'SYSTEM', severity: 'error', audience: 'internal' },
  'system.process_started': { category: 'SYSTEM', severity: 'info', audience: 'internal' },
  'system.ws_error': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
  'system.poll_error': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
  'system.reconcile_failed': { category: 'SYSTEM', severity: 'error', audience: 'internal' },
  'system.reconcile_enumerate_failed': { category: 'SYSTEM', severity: 'error', audience: 'internal' },
  'system.sweep_failed': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
  'system.catchup_poll_failed': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
  'system.loop_errored': { category: 'SYSTEM', severity: 'error', audience: 'internal' },
  'system.config_reloaded': { category: 'SYSTEM', severity: 'info', audience: 'internal' },
  'system.mirrors_reloaded': { category: 'SYSTEM', severity: 'info', audience: 'internal' },
  'system.replay_done': { category: 'SYSTEM', severity: 'info', audience: 'internal' },
  'system.recovery_failed': { category: 'SYSTEM', severity: 'error', audience: 'internal' },
  'system.mirror_error': { category: 'SYSTEM', severity: 'error', audience: 'internal' },
  'system.config_invalid_fallback': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
  'system.fatal': { category: 'SYSTEM', severity: 'error', audience: 'feed', pinned: true, coalesceMs: PINNED_COALESCE_MS, title: 'Bot Stopped — Fatal Error', render: 'system-fatal' },
  // Observability self-failures (D-7): audience:'internal' so they NEVER user-notify through the broken path.
  'system.journal_write_failed': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
  'system.notify_delivery_failed': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
  'system.alert_failed': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
  'system.heartbeat_write_failed': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
  // Deterministic fallback for a legacy `reason` that resolves to no known leaf (e.g. a producer reason not yet
  // migrated, like `build_error` / `failed` / `sign_land_failed`). The P1 shim back-fills this onto the `code`
  // column so the row is never code-less; audience:'internal' so an unmapped reason never reaches the user feed.
  'system.unmapped': { category: 'SYSTEM', severity: 'warn', audience: 'internal' },
} as const satisfies Record<string, CodeMeta>;

/** The closed code union — replaces every ad-hoc reason string. A missing meta is a build error (§2.2 test 1). */
export type CopyCode = keyof typeof RAW_CODE_REGISTRY;

/** Public registry: same data, widened so `CODE_REGISTRY[code]` is a `CodeMeta` (optional facets visible). */
export const CODE_REGISTRY: Record<CopyCode, CodeMeta> = RAW_CODE_REGISTRY;

/**
 * Back-compat: old verbatim journaled reason strings → their clean `CopyCode` leaf (SPEC §2.3). Where a leaf is
 * already the verbatim reason (e.g. `below_min_market_cap`), no alias is needed — the migration code resolves a
 * reason by first checking this map, then assuming the reason already IS a leaf within its namespace.
 *
 * INVARIANT (§2.2 test 2): every alias VALUE is a real `CopyCode`, and each old reason maps to exactly one leaf.
 */
export const LEGACY_REASON_ALIASES = {
  leader_closed: 'failsafe.activated',
  orphan: 'failsafe.orphan_closed',
  non_sol_pool: 'eligibility.non_sol_paired',
  twosided_unbuyable: 'eligibility.twosided.unbuyable',
  // §2.3 lists `twosided_unbuyable` but not its sibling; the §2.2-test-2 invariant ("every current journaled
  // reason maps to exactly one leaf") still requires this real producer reason to resolve — judgment call.
  twosided_token2022_too_wide: 'eligibility.twosided.token2022_too_wide',
  reshape_token_unbuyable: 'reshape.token_unbuyable',
  insufficient_balance: 'balance.insufficient',
  'dry-run': 'sign.dry_run',
  rug_sl: 'failsafe.rug_sl_triggered',
  // `wallb:*` → `wallb.*` (the colon-namespaced legacy form Wall B journals today).
  'wallb:foreign_sol_destination': 'wallb.foreign_sol_destination',
  'wallb:sol_spend_over_cap': 'wallb.sol_spend_over_cap',
} as const satisfies Record<string, CopyCode>;

export type LegacyReason = keyof typeof LEGACY_REASON_ALIASES;

/** Every registry key — used to resolve a verbatim leaf reason to its `namespace.<reason>` code. */
const ALL_CODES = Object.keys(CODE_REGISTRY) as CopyCode[];

/** The deterministic fallback code for a legacy reason that resolves to no known leaf (SPEC §8 P1). */
export const FALLBACK_CODE: CopyCode = 'system.unmapped';

/**
 * Resolve an old journaled `reason` string to its canonical `CopyCode` (SPEC §2.3), mirroring the migration rule
 * the registry test (`codes.test.ts`) locks: first the explicit alias map, else the unique `namespace.<reason>`
 * leaf. Returns `undefined` when no leaf matches (the caller then back-fills `FALLBACK_CODE`). Pure.
 *
 * An empty/absent reason has no functional code to map → `undefined` (a progress-outcome row carries no `reason`).
 */
export function resolveLegacyReason(reason: string | undefined): CopyCode | undefined {
  if (!reason) return undefined;
  const aliased = (LEGACY_REASON_ALIASES as Record<string, CopyCode>)[reason];
  if (aliased) return aliased;
  // No alias → the reason must already BE the leaf suffix of exactly one code (`namespace.<reason>`).
  const matches = ALL_CODES.filter((code) => code.slice(code.indexOf('.') + 1) === reason);
  return matches.length === 1 ? matches[0] : undefined;
}
