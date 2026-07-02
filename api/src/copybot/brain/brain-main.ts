/**
 * Copy-bot · Inc.2 — BRAIN process (NO keys, NO inbound socket). Detects the leader's DLMM events →
 * decides (sizing/caps, no filters in v1) → BUILDS the tx (SDK: FAITHFUL re-anchored open by-weight / close /
 * claim) → PUBLISHES a `SignRequest` on `cmd:sign` (Redis bus, HMAC). The vault signs+lands (separate process).
 *
 * Bundled CJS (tsup.copybot.config.ts) — imports the SDK, NEVER runs under tsx. Does NOT import the keypair.
 *   yarn tsup --config tsup.copybot.config.ts → node --env-file=../.env dist/copybot/brain-main.cjs [--once] [--seconds=N]
 */
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { Connection, type Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { pino } from 'pino';
import { type CapsState, checkCaps } from '@/domain/copybot/caps';
import { type SignRequest, SignRequestSchema } from '@/domain/copybot/contracts';
import { decideEntry } from '@/domain/copybot/decision';
import { routeWithPending } from '@/domain/copybot/dispatch';
import type { DetectedEvent } from '@/domain/copybot/events';
import { type JournalEntry, stageForKind } from '@/domain/copybot/journal';
import { RugSlTracker } from '@/domain/copybot/rug-sl';
import { jitoTipFor } from '@/domain/copybot/jito-tip';
import { type EffectiveConfig, effectiveFor, withEnvOverride } from '@/domain/copybot/config';

import { type FilterContext, filtersActive, neededSources, rangeCoveragePercent, resolveFilterContext, runFilters, type TokenSnapshot } from '@/domain/copybot/filters';
import { JupiterTokenGateway } from '@/domain/copybot/filters/sources/jupiter-token/jupiter-token-gateway';
import { TtlCache } from '@/domain/copybot/ttl-cache';
import { type EventSource, LeaderDetector } from '@/domain/copybot/leader-detector';
import { LeaderPositionTracker } from '@/domain/copybot/leader-position';
import { ATOMIC_BY_WEIGHT_BIN_LIMIT, isWideOpen } from '@/domain/copybot/open-routing';
import { chunkBySpan, fillContiguousWeights, lamportsToSol, reshapeToCalls } from '@/domain/copybot/position-adjust';
import { reanchorShape } from '@/domain/copybot/reanchor';
import { type TwoSidedPlan, planTwoSided, planTwoSidedReshape, sizeTwoSided } from '@/domain/copybot/two-sided';
import { planReconcile } from '@/domain/copybot/reconciliation';
import { decideResidualSell, minOutWithSlippage, planWalletSweep } from '@/domain/copybot/residual-sell';
import { classifyInstruction } from '@/domain/dlmm';
import { RedisBus } from '@/infrastructure/bus/redis-bus';
import { ControlChannel } from '@/infrastructure/bus/control-channel';
import { openDatabase } from '@/infrastructure/persistence/database';
import { decodeDlmmLegs } from '@/infrastructure/solana/dlmm/dlmm-event-decoder';
import { type WeightBin, buildAddByWeight, buildAddByWeight2, buildClaimTx, buildCloseTx, buildCreateEmptyPosition, buildOpenByWeight, buildRemovePartial, createDlmmPair, isToken2022Pool } from '@/infrastructure/solana/dlmm/dlmm-tx-builder';
import { readLeaderPositionShape, type UserPosition, readUserPositions } from '@/infrastructure/solana/dlmm/leader-position-reader';
import { readActiveTokenPrice } from '@/infrastructure/solana/dlmm/active-bin-price';
import { OnchainPoolMetaReader } from '@/infrastructure/solana/dlmm/pool-meta';
import { DEFAULT_JUPITER_BASE_URL, WSOL_MINT, buildJupiterSwapTx, getJupiterBuyQuoteExactIn, getJupiterQuote } from '@/infrastructure/solana/jupiter/jupiter-swap-builder';
import { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';
import { PriorityFeeOracle } from '@/infrastructure/solana/priority-fee-oracle';
import { HeliusTxSubscriber } from '@/infrastructure/solana/helius-tx-subscriber';
import { readAllOwnerTokenBalances, readOwnerTokenBalance } from '@/infrastructure/solana/token-balance-reader';
import { HeliusTokenMetadataGateway } from '@/infrastructure/solana/token-metadata-gateway';
import { createAlertWebhookSink } from '@/copybot/alert';
import { assertBusKey } from '@/copybot/bus-key-guard';
import { ConfigStore } from '@/copybot/config-store';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { CopyEvents } from '@/copybot/observability/copy-events';
import { type CopyCode, FALLBACK_CODE, resolveLegacyReason } from '@/domain/copybot/observability/codes';
import type { EmitInput } from '@/domain/copybot/observability/input';
import { EventStore } from '@/copybot/observability/event-store';
import { HeartbeatStore } from '@/copybot/heartbeat-store';
import { type BrainStatusDetail, DETECTION_STALE_FAILURES, HEARTBEAT_INTERVAL_MS, detectionHealthy, shouldAlertDetectionStale } from '@/domain/copybot/status';
import { deriveCommandId } from '@/copybot/command-id';
import { makeDetectionDeps } from '@/copybot/detection';
import { derivePositionKeypair } from '@/copybot/ephemeral-position';
import { envEffectiveOverride } from './env-overrides';
import { applyPriorityFee, withCuLimit } from './compute-budget';
import { type Mirror, MirrorRegistry } from './mirror-registry';
import { MirrorStore } from './mirror-store';
import { type ExecutedBatchDeps, processExecutedBatch } from './dispatch-executed';
import { createPositionQueue } from './position-queue';
import { createPendingOpenReservations } from './pending-open-reservations';
import { type PendingOpenMaps, type PendingStashKeys, pendingOpenLeaders, pendingStashesFor, stashCount } from './pending-open-cancel';
import { RugExitStore } from '@/copybot/rug-exit-store';

const STREAM = 'copybot:cmd:sign';
const HOP = 'cmd:sign';
const POLL_MS = 15_000;
const RECON_MS = 30_000; // on-chain reconcile cadence (no-miss-close backstop)
const RECLOSE_GRACE_MS = 60_000; // wait this long after publishing a close before a reconcile re-close (let it land)
const RECONCILE_OPEN_GRACE_MS = Number(process.env.RECONCILE_OPEN_GRACE_MS ?? '30000'); // a just-opened copy may be unconfirmed for ~1-2s (direct getAccountInfo) → skip the 1st reconcile tick after open; 30s = generous margin, minimal backstop delay (anti false-close → no-dormant)
const DEADLINE_SLOTS = 150; // ~60s
// Swap/reshape execution tunables now live in the runtime config (eff().execution) — see config/defaults.ts.
const SWEEP_MS = Number(process.env.SWEEP_MS ?? '60000'); // wallet token→SOL safety-sweep cadence (SYSTEM): the no-miss backstop behind the close-triggered sell (catches any dormant non-SOL left by downtime/a missed close)
// The close-sell + the safety-sweep sell ANY non-SOL residual (the wallet must NEVER hold a non-SOL token). The
// economic floor is `minSellOutLamports` (a SOL-value gate applied AFTER quoting) — NOT a raw-token threshold, which
// would mis-scale across token decimals AND conflate with the two-sided-CLASSIFICATION cutoff (`dustTokenRaw`, which
// decides whether a leader TOKEN LEG is worth buying — a different concern). So selling uses 0 here.
const SELL_RESIDUAL_DUST_RAW = 0n;
const EV_EXECUTED_STREAM = 'copybot:ev:executed';
const RUG_SL_POLL_MS = 15_000; // rug-SL price-poll cadence: ~4 samples per a 60s window — fast enough to catch a crash, one lbPair read per open pool (economical)
const RUG_SL_RETAIN_MS = 180_000; // keep ≥ any sane windowSeconds so the detector always has its full lookback
// A leader OPEN's WS event can arrive BEFORE the position account is readable on our RPC node (read-after-write lag).
// Retry the shape read briefly so a transient read-miss never DROPS a leader open (the sig is already deduped, so the
// poll won't re-cover it → no other backstop). The normal case reads on the 1st try → zero added latency.
const OPEN_SHAPE_READ_RETRIES = 6;
const OPEN_SHAPE_READ_DELAY_MS = 1_000;
// When the tx decode says an open is TWO-SIDED, wait longer for BOTH legs' bin arrays to index (RPC lag can be
// seconds under load) — fidelity demands the full shape, and a half (one-sided) copy is forbidden. A ceiling: real
// two-sided positions index well within this; production (RPC not shared) settles in ~1-2s.
const TWO_SIDED_SHAPE_MAX_READS = 18;
// A leader ADD/REMOVE seen via WS may not be on-chain-readable yet → retry the resync read+compute until the deficit
// appears (else a premature read = no deficit = the copy wouldn't grow/shrink). Only when the event carries a real change.
const RESYNC_READ_RETRIES = 8;
const RESYNC_MIN_CHANGE_SOL = 0.001;
// addLiquidityByWeight2 distributes a total by per-bin bps; the rounded per-bin amounts can sum to a hair MORE than
// the total → the token TransferChecked fails "insufficient funds". Deposit just under the wallet balance to absorb
// it (the tiny remainder is swept). ≤0.1% → negligible fidelity impact.
const depositableToken = (raw: bigint): bigint => (raw > 10_000n ? (raw * 999n) / 1000n : raw);
const CONFIG_POLL_MS = 5_000; // re-read the DB-backed runtime config (sizing/caps/two-sided) so web edits apply live
const SNAPSHOT_TTL_MS = 30_000; // per-mint filter-snapshot cache TTL (short; pre-warm makes repeat opens free)
const FILTER_TIMEOUT_MS = 800; // hard cap on the filter-data fetch so a slow Jupiter never blocks the open
// A routed OPEN reserves its leader position until `registry.open` runs. For MULTI-TX opens (two-sided buy→open,
// Token-2022 create→deposit, wide split) that happens in a later ev:executed continuation, seconds after the open
// handler returned. This TTL must exceed the longest such window so a follow-up leader add during it routes to
// resync (not a 2nd open); it matches TOKEN2022_DEPOSIT_GRACE_MS (the orphan-close grace for the same window). A
// stale reservation self-heals (it only suppresses re-opening the SAME position for ≤TTL, never a double open).
const OPEN_PENDING_TTL_MS = 90_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const cfg = {
  httpUrl: process.env.SOLANA_HTTP_URL ?? '',
  wsUrl: process.env.SOLANA_WS_URL,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6385',
  dbUrl: process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora',
  leader: process.env.COPYBOT_LEADER ?? '8ryctvNwpJTuuap3wuNTfcyEx4DjSuXvhGXSDHNaU8sQ',
  ownerPubkey: process.env.COPIER_OWNER ?? 'Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz',
  balanceSol: Number(process.env.COPIER_BALANCE_SOL ?? '10'),
  jupiterBaseUrl: process.env.JUPITER_BASE_URL ?? DEFAULT_JUPITER_BASE_URL,
  jitoEnabledEnv: process.env.COPYBOT_JITO !== undefined ? process.env.COPYBOT_JITO === 'true' : undefined, // env override of the DB jitoEnabled (anti-sandwich tip ix)
  priorityFeeOracleEnv: process.env.COPYBOT_PRIORITY_FEE_ORACLE !== undefined ? process.env.COPYBOT_PRIORITY_FEE_ORACLE === 'true' : undefined, // env override of the DB priorityFeeOracle
};
// Sizing/caps/two-sided/filters all come from the DB-backed config (config-store), resolved per leader via eff().
// The env override (migration bridge) is SPARSE: a var, WHEN SET, takes precedence (preserves the on-chain bench);
// an UNSET var falls through to the DB config so it stays authoritative in production.
const ENV_EFFECTIVE_OVERRIDE = envEffectiveOverride(process.env);

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const firstTx = (t: Transaction | Transaction[]): Transaction => (Array.isArray(t) ? (t[0] as Transaction) : t);
// A by-weight OPEN/ADD build must be a SINGLE tx — if the SDK chunked it (range too wide for one tx), publishing only
// the first tx would deposit nothing (create the position but not the liquidity, or land a partial deposit). Wide
// opens/adds are routed through create + add2 (one ≤70-bin deposit tx); this asserts that invariant — fail LOUD
// rather than silently drop a chunk (the no-miss/shape-fidelity pillar). Close/claim/remove are ≤70 bins → 1 tx.
const onlyTx = (t: Transaction | Transaction[], context: string): Transaction => {
  const arr = Array.isArray(t) ? t : [t];
  if (arr.length !== 1) throw new Error(`${context}: build chunked into ${arr.length} txs (range too wide) — aborting, no partial open/deposit`);
  return arr[0] as Transaction;
};
// Merge several SDK txs into ONE (concatenate their instructions). A WIDE atomic open chunks into [pre, main, post];
// the DEPOSIT half is `main` (the native addLiquidityOneSide/addLiquidityByWeight) + `post` (unwrap leftover WSOL).
// We publish `pre` (create+wrap) as TX1, then this merged deposit as TX2 — the unwrap MUST ride with the deposit (it
// references no pool/position of its own → Wall B would reject it alone). Stale CU/fee/blockhash are reset at publish.
const mergeDeposit = (txs: Transaction[]): Transaction => {
  const merged = new Transaction();
  for (const tx of txs) for (const ix of tx.instructions) merged.add(ix);
  return merged;
};

// A two-sided open/add builds a tx that DEPOSITS token the copier doesn't hold yet (the BUY lands first, in the
// coffre). The SDK's compute-unit estimation SIMULATES that deposit → fails "insufficient funds" → the tx ships
// with no/low CU limit → fails on-chain. Force an explicit CU limit so the build never depends on that estimation.
const TWO_SIDED_CU_LIMIT = 1_400_000; // max CU cap (free — only used CU is metered): a wide 17-bin two-sided open/add needs >400k; the build's own estimation fails (token not held yet)

// BUILD-AFTER-BUY: a two-sided OPEN can't be built before the token is bought — the copier's token ATA doesn't
// even exist yet, so the SDK build produces a tx that fails on-chain. We publish the BUY, stash the open context
// here keyed by the buy's commandId, and build+publish the open only when the buy's ev:executed arrives (token +
// ATA now present → clean build). (A two-sided reshape ADD does NOT need this — its position's ATA already exists.)
// KNOWN LIMIT — these in-memory pending maps (pendingTwoSidedOpens / pendingReshapeAdds / pendingToken2022Deposits /
// pendingToken2022Mirrors) are NOT persisted, so a FULL process crash loses them: a buy/create confirm replayed after
// restart whose pending entry is gone will no-op (the deferred open/deposit is dropped, recovered only by the
// orphan-sweep / reconcile backstops). The ev:executed PEL drain below covers the close path + transient errors within
// a LIVE process; persisting these maps to survive a crash is a separate follow-up (not in this fix).
const pendingTwoSidedOpens = new Map<string, { e: DetectedEvent; dist: WeightBin[]; sizeLamports: bigint; solSide: 'X' | 'Y'; tokenMint: string; sizeSol: number }>();

// TOKEN-2022 2-TX OPEN: a Token-2022 leg can't be deposited by the v1 by-weight ix (on-chain it pins the token
// program to classic). The deposit must use the v2 ix (addLiquidityByWeight2), which is add-to-EXISTING → the open
// splits into TX1 createEmptyPosition (kind 'open') then TX2 addLiquidityByWeight2 (kind 'add'), sequenced via
// ev:executed (create lands → deposit; deposit lands → persist the mirror). We persist the mirror ONLY after the
// deposit lands, so a crash/failure between the two leaves an UNTRACKED empty position that the orphan-sweep
// auto-closes (no dormant position). `buildingToken2022Positions` (with a grace) stops the sweep from closing a
// position WHILE its deposit is still in flight; once the grace expires (deposit never landed) the sweep cleans it.
// Keyed by the CREATE's commandId. Two deposit strategies share this map + the create→deposit→finalize sequencing:
//  · REBUILD (Token-2022 two-sided): `dist`/`totalX`/`totalY` present → addLiquidityByWeight2 is REBUILT after the
//    create lands (add2 fetches the positionV2 account, so it can't be pre-built).
//  · PREBUILT (one-sided wide / classic-wide two-sided): `prebuiltDeposit` present → the deposit (native
//    addLiquidityOneSide/addLiquidityByWeight + unwrap, built atomically with the create) is published as-is.
const pendingToken2022Deposits = new Map<string, { e: DetectedEvent; lower: number; upper: number; sizeSol: number; prebuiltDeposit?: Transaction; dist?: WeightBin[]; totalX?: bigint; totalY?: bigint }>();
const pendingToken2022Mirrors = new Map<string, { leaderPosition: string; ourPosition: string; pool: string; nonSolSymbol: string | null; sizeSol: number; lower: number; upper: number; leaderSizeSol: number }>();
// TWO-SIDED RESHAPE ADD (grow with a token-leg deficit): like the open, the token can't be bought via ExactOut on a
// Token-2022 coin → buy via ExactIn (variable output) then build+publish the add ONCE the buy lands (deposit the
// ACTUAL balance). Stashed by the reshape buy's commandId; consumed in publishReshapeAddAfterBuy.
const pendingReshapeAdds = new Map<string, { dist: WeightBin[]; addLamports: bigint; solSide: 'X' | 'Y'; tokenMint: string; lower: number; upper: number; totalAddSol: number; ourPosition: string; pool: string; leaderPosition: string; signature: string }>();
const buildingToken2022Positions = new Map<string, number>(); // ourPosition → ms the create was published (orphan-close grace while the deposit lands)
// DUPLICATE-OPEN GUARD (two mechanisms). (1) `positionQueue` serializes ALL handler work for ONE leader position:
// event B's routing is computed only AFTER event A's handler settled (so a classic open's `registry.open` @511 has
// run → B sees tracked=true → resync, not a 2nd open). (2) `pendingOpens` bridges the MULTI-TX open window (the
// open handler returns before `registry.open`, which runs in a later ev:executed continuation): a routed open
// reserves its leader position; the tracked test treats a pending reservation as tracked; each `registry.open`
// site clears it; a stale entry self-heals after OPEN_PENDING_TTL_MS. Together they make a follow-up add during an
// open-in-flight route to resync/ignore instead of a duplicate real-money open.
const positionQueue = createPositionQueue();
const pendingOpens = createPendingOpenReservations(OPEN_PENDING_TTL_MS);
// A leader position whose IN-FLIGHT multi-tx open (two-sided buy→open, Token-2022 create→deposit, wide split) must
// NOT complete because the leader CLOSED before the open landed. The open handler returned before `registry.open`
// (which runs in a later ev:executed continuation), so `handleClose` finds no mirror — without this signal a queued
// continuation would deploy capital into the pool the leader just EXITED (a fast scalp / rug exit). The continuations
// run from the ev:executed loop — a DIFFERENT execution path than the position-queue — so we need this cross-path
// cancellation marker. `cancelPendingOpen` sets it; each continuation clears it via `consumeOpenCancellation` before
// publishing on-chain. KNOWN LIMIT (like the pending maps above): in-memory only — a FULL process crash loses it, but
// the mirror was never registered so nothing is stuck, and the periodic sweep clears any token already bought.
const cancelledOpens = new Set<string>();
// A two-sided open's BOUGHT token sits on the wallet between the buy landing and the deposit landing. Since the
// safety-sweep now sells ANY non-SOL residual (SELL_RESIDUAL_DUST_RAW=0), it must NOT sell that in-flight token
// mid-open (it would empty the token leg). Track the mint while the open is in flight; the sweep skips it within a
// grace, after which a still-present token (the open failed) IS a real stranded residual → swept (cleanup).
const inFlightBuyMints = new Map<string, number>(); // tokenMint → ms the two-sided buy was published
// A published residual SELL (close-triggered OR safety-sweep) carries no token identity on its `ev:executed`
// confirm — only the commandId/pool. Stash the sold token (mint + resolved symbol if known) keyed by the sell's
// commandId at publish time, so the sell-confirm handler can name the token in the FEED `swap.executed` line
// ("Swapped X → SOL") WITHOUT an extra RPC. Mirrors the inFlightBuyMints / pendingReshapeAdds stash pattern.
const pendingSellMints = new Map<string, { tokenMint: string; nonSolSymbol: string | null; pool: string }>();
// The sweep must not sell the bought token during buy → (create →) deposit (≤ ~20s under load). Kept SHORT so it
// expires soon after the deposit lands — else it would also block the safety-sweep from selling that same token's
// CLOSE residual (the close returns it to the wallet) for too long. The close-triggered sell is the primary path;
// this grace only gates the backstop sweep.
const INFLIGHT_BUY_GRACE_MS = 30_000;
const TOKEN2022_DEPOSIT_GRACE_MS = 90_000; // orphan-close grace for an empty position whose deposit is still in flight; past it, a non-deposited position is cleaned
const TOKEN2022_MAX_OPEN_BINS = 70; // a single createEmptyPosition + single addLiquidityByWeight2 chunk cover ≤70 bins; wider Token-2022 two-sided opens are skipped (no partial deposit)

async function main(): Promise<void> {
  if (!cfg.httpUrl) {
    log.error('SOLANA_HTTP_URL missing');
    process.exit(1);
  }
  // Fail-closed on the bus HMAC (forging cmd:sign would make the vault sign): refuse to boot with a missing/insecure key.
  const busKey = assertBusKey(process.env);
  if ('error' in busKey) {
    log.error(busKey.error);
    process.exit(1);
  }
  const hmacKey = busKey.key;
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const secondsArg = args.find((a) => a.startsWith('--seconds='));
  const autoStopSec = secondsArg ? Number(secondsArg.slice('--seconds='.length)) : 0;

  const conn = new Connection(cfg.httpUrl, 'confirmed');
  const leaderPk = new PublicKey(cfg.leader);
  const ownerPk = new PublicKey(cfg.ownerPubkey);
  const poolReader = new OnchainPoolMetaReader(conn);
  const tokenMeta = new HeliusTokenMetadataGateway(cfg.httpUrl, log);
  const bus = RedisBus.connect(cfg.redisUrl);
  const tracker = new LeaderPositionTracker();
  const registry = new MirrorRegistry();
  const db = openDatabase(cfg.dbUrl);
  const store = new MirrorStore(db); // no-dormant persistence (survives restarts)
  // ONE observability emitter bound to this tenant (mono-user PoC): a tenant-scoped pino child is its logger. The
  // brain's call sites emit TYPED codes through it directly; every row back-fills user/wallet/correlation. Operator-
  // actionable (pinned) events also fan out to the external ALERT_WEBHOOK via the injected sink (no-op when unset).
  const tlog = log.child({ userId: SYSTEM_USER_ID, wallet: cfg.ownerPubkey, process: 'brain' });
  const alertSink = createAlertWebhookSink(process.env.ALERT_WEBHOOK, tlog);
  const events = new CopyEvents(new EventStore(db, tlog), tlog, { userId: SYSTEM_USER_ID, wallet: cfg.ownerPubkey, process: 'brain' }, alertSink);
  // P2: emit a TYPED event for a call site whose `reason` is RUNTIME-DYNAMIC (decision.reason, cap.reason, the
  // filter verdict, the generic publish marker). The leaf == the verbatim reason (SPEC §2.1 + resolveLegacyReason);
  // an unmapped/absent reason deterministically falls back to `system.unmapped` (never code-less). The pure
  // `resolveLegacyReason` is the SAME mapping the P1 shim used, so the persisted `code` column is unchanged — only
  // the registry severity/category/audience/pinned now become exact (the point of P2). Fire-and-forget; never throws.
  const emitFor = (reason: string | undefined, fields: EmitInput<CopyCode>): void => {
    events.emit(resolveLegacyReason(reason) ?? FALLBACK_CODE, fields);
  };
  // Per-leg detection correlation keys for the no-copy SKIP events (which carry no commandId/eventKey of their own):
  // the emit dedup keys on `(correlationId, code)`, so distinct skipped opens/reshapes need a UNIQUE eventKey or
  // they would collapse into one row under the 120s LRU. WS + cursor-poll re-detect of the SAME leg shares the key
  // (correctly collapses to one row). The leaf differs per stage so an open-skip and a reshape-skip never alias.
  const openSkipKey = (e: DetectedEvent): string => `${cfg.leader}:${e.pool}:open-skip:${e.signature}:${e.position}`;
  const reshapeSkipKey = (e: DetectedEvent, m: Mirror): string => `${cfg.leader}:${m.pool}:reshape-skip:${e.signature}:${m.ourPosition}`;
  // Per-position correlation keys for the `lifecycle.*_confirmed` FEED events. These confirmed emits carry no
  // commandId of their own, yet the emit dedup keys on `(correlationId, code)` — without a per-position key the
  // `correlationId` would be empty and two DISTINCT positions' confirms within the 120s LRU would collapse into one
  // row (lost feed). Keyed by OUR position so the SAME position's duplicate confirms (ev:executed + reconcile)
  // correctly collapse to one row, while distinct positions stay distinct. The leaf differs per code.
  const openConfirmedKey = (pool: string, ourPosition: string): string => `${cfg.leader}:${pool}:open-confirmed:${ourPosition}`;
  const closeConfirmedKey = (pool: string, ourPosition: string): string => `${cfg.leader}:${pool}:close-confirmed:${ourPosition}`;
  const configStore = new ConfigStore(db, log);
  let runtimeConfig = await configStore.seedIfAbsent(); // the CopybotConfig blob; polled + ping-reloaded live below
  const reloadConfig = async (): Promise<void> => {
    runtimeConfig = await configStore.load();
  };
  // Resolve the EFFECTIVE config for our (single) leader, then apply the env/bench override (migration bridge).
  // Pure + cheap → recomputed at each point of use so a live reload always takes effect on the next event.
  const eff = (): EffectiveConfig => withEnvOverride(effectiveFor(runtimeConfig, cfg.leader), ENV_EFFECTIVE_OVERRIDE);
  const rugSlTracker = new RugSlTracker(RUG_SL_RETAIN_MS); // per-position price windows for the rug-SL crash check
  const rugExitStore = new RugExitStore(db, log); // durable set of LEADER positions we rug-exited (suppress re-open)
  const rugExited = await rugExitStore.load(); // seed across restart so a leader add can't re-enter a rug-exited position
  const rugExitPending = await rugExitStore.loadPending(); // seed across restart so a failed rug-SL close keeps being re-closed until confirmed gone
  const control = ControlChannel.connect(cfg.redisUrl); // instant config-reload pings (kill-switch applies in <100ms)
  const heartbeat = new HeartbeatStore(db, log, 'brain'); // process status the web reads (online + positions/exposure/latency)
  let lastActionAt: number | null = null; // ms of the last build+publish (status snapshot)
  let lastLatencyMs: number | null = null; // brainMs of that last action
  // Detection-liveness (observability). The poll/reconcile timers below run with LOG-ONLY `.catch` handlers; if
  // they throw forever the bot is silently BLIND to leader events while the heartbeat stays GREEN. These stamps +
  // consecutive-failure counters feed the status snapshot AND the watchdog alert. wsConnected is mirrored from the
  // WS subscriber's connection-change callback (set once `sub` exists, below).
  let wsConnected = false; // last-known WS trigger connectivity
  let lastPollAt: number | null = null; // ms of the last SUCCESSFUL cursor poll
  let lastReconcileAt: number | null = null; // ms of the last SUCCESSFUL reconcile sweep
  let pollFailures = 0; // CONSECUTIVE poll failures (reset on a success)
  let reconcileFailures = 0; // CONSECUTIVE reconcile failures (reset on a success)
  let detectionStaleAlerted = false; // once-per-episode gate; re-armed when BOTH counters are back to 0
  const brainStatus = (): BrainStatusDetail => {
    const open = registry.openPositions();
    return { leader: cfg.leader, openPositions: open.length, exposureSol: open.reduce((s, m) => s + m.sizeSol, 0), lastActionAt, lastLatencyMs, wsConnected, lastPollAt, lastReconcileAt, pollFailures, reconcileFailures };
  };
  // A detector loop (poll or reconcile) succeeded: stamp its time, zero its consecutive-failure counter, and re-arm
  // the stale alert once detection is FULLY healthy again (both counters at 0). Observability only.
  const onDetectionSuccess = (which: 'poll' | 'reconcile'): void => {
    if (which === 'poll') {
      lastPollAt = Date.now();
      pollFailures = 0;
    } else {
      lastReconcileAt = Date.now();
      reconcileFailures = 0;
    }
    if (detectionHealthy(pollFailures, reconcileFailures)) detectionStaleAlerted = false;
  };
  // A detector loop failed: bump its consecutive-failure counter and — after DETECTION_STALE_FAILURES in a row —
  // emit the pinned "bot may be blind" alert ONCE per stale episode (the flag suppresses repeats until a recovery
  // re-arms it). The existing per-loop `log.error` is kept at the call site. Observability only.
  const onDetectionFailure = (which: 'poll' | 'reconcile'): void => {
    if (which === 'poll') pollFailures += 1;
    else reconcileFailures += 1;
    if (shouldAlertDetectionStale(pollFailures, reconcileFailures, detectionStaleAlerted)) {
      detectionStaleAlerted = true;
      events.emit('system.detection_stale', {
        stage: 'failsafe',
        outcome: 'failed',
        leader: cfg.leader,
        eventKey: `detection-stale:${Date.now()}`, // fresh per episode so a later episode isn't dedup-suppressed
        adminDetail: { pollFailures, reconcileFailures, threshold: DETECTION_STALE_FAILURES },
      });
    }
  };
  const recentlyPublishedClose = new Map<string, number>(); // ourPosition → ms a close was last published (reClose grace)
  const blockhashCache = new BlockhashCache(async () => {
    const b = await conn.getLatestBlockhash();
    return { blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight };
  });
  // Live priority-fee oracle (opt-in): scoped to DLMM-program activity, background-refreshed so serializeUnsigned
  // reads it instantly. Off ⇒ never started, never queried → the static tier stands (zero extra RPC).
  const priorityFeeOracle = new PriorityFeeOracle(cfg.httpUrl, DLMM_PROGRAM_ID);
  const oracleOn = (): boolean => cfg.priorityFeeOracleEnv ?? runtimeConfig.user.priorityFeeOracle;
  const snapshotCache = new TtlCache<TokenSnapshot>(SNAPSHOT_TTL_MS);
  const jupiterToken = new JupiterTokenGateway({
    apiKey: process.env.JUPITER_TOKEN_API_KEY,
    onError: (err, mint) => log.warn({ err, mint }, 'jupiter token snapshot failed (filter data unavailable)'),
  }).getSnapshot;
  const filterDeps = { jupiterToken, snapshotCache };
  log.info({ filters: eff().filters }, '🧪 entry filters loaded');

  const capsState = (): CapsState => {
    const open = registry.openPositions();
    return { openPositions: open.length, totalExposureSol: open.reduce((s, m) => s + m.sizeSol, 0), tokenOpenCount: 0, openTimestampsMs: [] };
  };

  async function publish(sr: Omit<SignRequest, 'issuedAtMs'>, journalHint?: Partial<JournalEntry>): Promise<void> {
    const full: SignRequest = { ...sr, issuedAtMs: Date.now() }; // timestamp at publish time (latency)
    SignRequestSchema.parse(full); // local guardrail: we only publish a valid contract
    const id = await bus.publish(STREAM, HOP, hmacKey, full);
    // Machine-readable publish marker: the EXACT copy pubkey + kind we just published (the journal's formatted line
    // carries neither as a field). Ops visibility + lets a consumer track the published copy without RPC enumeration.
    log.info({ kind: full.kind, our: full.positionPubkey, pool: full.pool, streamId: id }, '📤 published');
    // Activity journal: EVERY published intent is recorded once here (single backstop). A context-specific publish
    // (a failsafe / orphan / rug-SL re-close) passes a `reason` hint that resolves to the pinned `failsafe.*` code
    // (SPEC §2.1) — every other publish is a plain internal `lifecycle.open_published` trace (the on-chain
    // confirmation arrives later as `lifecycle.*_confirmed`, never here). The leaf == the verbatim hint reason.
    // NB: `severity` is denormalized from the resolved code in the typed model (the failsafe codes are already
    // warn/error), so the legacy `journalHint.severity` is no longer plumbed — the registry now governs it.
    const reason = journalHint?.reason;
    const code = reason ? (resolveLegacyReason(reason) ?? FALLBACK_CODE) : 'lifecycle.open_published';
    events.emit(code, {
      stage: journalHint?.stage ?? stageForKind(full.kind),
      outcome: journalHint?.outcome ?? 'published',
      kind: full.kind,
      leader: cfg.leader,
      pool: full.pool,
      leaderPosition: journalHint?.leaderPosition,
      ourPosition: full.positionPubkey,
      commandId: full.commandId,
      eventKey: full.eventKey,
      leaderSizeSol: journalHint?.leaderSizeSol,
      ourSizeSol: full.sizeSol,
      reason,
      adminDetail: { targetBinRange: full.targetBinRange, streamId: id, ...journalHint?.detail },
    });
  }

  // Jito on = env override (bench) else the user-level DB flag; mirrors the coffre's landing decision so the tip
  // is added exactly when the vault will bundle. jitoEnabled is user-level only (not per-leader-overridable).
  const jitoOn = (): boolean => cfg.jitoEnabledEnv ?? runtimeConfig.user.jitoEnabled;
  let jitoTipSeed = 0; // rotates the tip across Jito's accounts (per-tip) to avoid contention

  function serializeUnsigned(tx: Transaction): string {
    tx.feePayer = ownerPk;
    tx.recentBlockhash = blockhashCache.get().blockhash; // cached: the vault re-sets a fresh one before signing → no hot-path RTT
    const pf = eff().priorityFee;
    const live = oracleOn() ? priorityFeeOracle.get(pf.tier) : null; // live floor in congestion; null ⇒ static tier
    const prioritySpent = applyPriorityFee(tx, pf, live); // capped priority fee on every DLMM tx (Wall B allows ComputeBudget)
    // Anti-sandwich Jito tip, INSIDE the shared priority-fee cap (priority + tip ≤ maxCapSol). Only has effect when
    // the vault bundles; on the RPC fallback the tip burns (small, capped, only when Jito is on). Wall B allowlists
    // a tip to a known Jito account up to its own hard cap. Default off ⇒ no tip ix at all.
    const tip = jitoTipFor(jitoOn(), pf.maxCapSol * LAMPORTS_PER_SOL, prioritySpent, jitoTipSeed++);
    if (tip) tx.instructions.push(SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: tip.account, lamports: tip.lamports }));
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }

  async function slots(): Promise<{ issuedAtSlot: number; deadlineSlot: number }> {
    const s = await conn.getSlot();
    return { issuedAtSlot: s, deadlineSlot: s + DEADLINE_SLOTS };
  }

  // A freshly-changed leader position can read PARTIALLY (its bin arrays aren't indexed yet → a two-sided open's TOKEN
  // leg, or a fresh add, reads as 0), making the bot misclassify a two-sided open as one-sided or skip a reshape (RPC
  // read-after-write lag). Read until the shape is RELIABLE: a both-legs shape is fully indexed (return at once → zero
  // added latency on the common two-sided open); a single-leg shape is confirmed STABLE (total liquidity unchanged
  // across two reads) before trusting it as genuinely one-sided / settled. null only if the position is never readable.
  async function readStableShape(poolPk: PublicKey, owner: PublicKey, position: string, pair: Awaited<ReturnType<typeof createDlmmPair>>, expectBothLegs = false) {
    let last: Awaited<ReturnType<typeof readLeaderPositionShape>> = null;
    let lastTotal = -1n;
    const maxReads = expectBothLegs ? TWO_SIDED_SHAPE_MAX_READS : OPEN_SHAPE_READ_RETRIES;
    for (let r = 0; r <= maxReads; r++) {
      if (r > 0) await sleep(OPEN_SHAPE_READ_DELAY_MS);
      const shape = await readLeaderPositionShape(conn, poolPk, owner, position, pair);
      if (!shape) continue; // not readable yet → retry
      if (shape.perBin.some((b) => b.x > 0n) && shape.perBin.some((b) => b.y > 0n)) return shape; // both legs indexed
      // The tx decode says this is two-sided but a leg's bin array isn't indexed yet → DON'T accept the partial
      // (single-leg) shape; keep reading until the missing leg appears.
      if (expectBothLegs) {
        last = shape;
        continue;
      }
      const total = shape.perBin.reduce((s, b) => s + b.x + b.y, 0n);
      if (last && total === lastTotal && total > 0n) return shape; // single-leg but stable → genuinely settled
      last = shape;
      lastTotal = total;
    }
    // Expected two-sided but never saw both legs → return null (NOT a half/single-leg shape): handleOpen then SKIPS
    // the open rather than copying a forbidden one-sided half of a two-sided leader (both-or-nothing).
    return expectBothLegs ? null : last;
  }

  async function handleOpen(e: DetectedEvent): Promise<void> {
    log.info({ position: e.position, pool: e.pool, depositSol: e.depositSol }, '🔨 handleOpen start');
    const ec = eff();
    const decision = decideEntry(e, { ...ec.sizing, skipNonSolPaired: true }, { availableBalanceSol: cfg.balanceSol });
    if (decision.outcome === 'skipped') {
      // dynamic reason: below_min_floor (sizing) / insufficient_balance (balance, pinned) / non_sol_paired — resolved to its leaf.
      // `eventKey` (the per-open detection correlation) keys the emit dedup so distinct opens skipped for the same
      // reason stay DISTINCT rows (an empty correlation would collapse them); WS+poll re-detect of one leg collapses.
      emitFor(decision.reason, { stage: 'open', outcome: 'skipped', reason: decision.reason, leader: cfg.leader, pool: e.pool, leaderPosition: e.position, eventKey: openSkipKey(e), leaderSizeSol: e.depositSol, adminDetail: { mint: e.nonSolMint, nonSolSymbol: e.nonSolSymbol, configuredSol: cfg.balanceSol } });
      return;
    }
    const cap = checkCaps(ec.caps, capsState(), decision.sizeSol, Date.now());
    if (cap.action === 'block') {
      // dynamic cap reason: kill_switch_* (internal) / max_open_positions / max_concurrent_per_token / max_opens_per_window / max_total_exposure (feed).
      emitFor(cap.reason, { stage: 'open', outcome: 'blocked', reason: cap.reason, leader: cfg.leader, pool: e.pool, leaderPosition: e.position, eventKey: openSkipKey(e), leaderSizeSol: e.depositSol, ourSizeSol: decision.sizeSol, adminDetail: { mint: e.nonSolMint, nonSolSymbol: e.nonSolSymbol } });
      return;
    }

    const poolPk = new PublicKey(e.pool);
    // Latency budget (≤3s SLA): fire the INDEPENDENT reads in PARALLEL — the DLMM pair (~300ms, DLMM.create), the
    // slot fetch, and the entry-filter data all overlap the pool-meta read instead of running after it. (The pair
    // doesn't depend on meta; the only sequential link is shape ← pair and build ← shape.) `filterDataP` fetches
    // nothing when only local/leader-shape filters are enabled. ONE shared DLMM instance serves the read AND build.
    const pairP = createDlmmPair(conn, poolPk);
    const slotsP = slots();
    const filterDataP = resolveFilterContext(e.nonSolMint, neededSources(ec.filters), filterDeps, { nowMs: Date.now(), timeoutMs: FILTER_TIMEOUT_MS });

    const meta = await poolReader.loadPoolMeta(e.pool);
    if (!meta?.solSide) {
      void pairP.catch(() => undefined); // non-SOL skip → discard the in-flight pair read (no unhandled rejection)
      events.emit('eligibility.non_sol_paired', { stage: 'open', outcome: 'skipped', reason: 'non_sol_pool', leader: cfg.leader, pool: e.pool, leaderPosition: e.position, eventKey: openSkipKey(e), adminDetail: { mint: e.nonSolMint, nonSolSymbol: e.nonSolSymbol } });
      return;
    }

    const pair = await pairP;
    // Read the leader's shape RELIABLY. The tx decode tells us AUTHORITATIVELY whether the leader deposited a TOKEN
    // leg (two-sided) — independent of the race-prone shape read; when so, wait for BOTH legs to index before
    // classifying (a partial read would misclassify a two-sided open as one-sided = a forbidden half copy).
    const expectTwoSided = (e.depositTokenRaw ?? 0) > ec.execution.dustTokenRaw;
    const shape = await readStableShape(poolPk, leaderPk, e.position, pair, expectTwoSided);
    if (!shape) {
      events.emit('detect.leader_position_not_found', { stage: 'open', outcome: 'skipped', reason: 'leader_position_not_found', leader: cfg.leader, pool: e.pool, leaderPosition: e.position, eventKey: openSkipKey(e), adminDetail: { afterRetries: OPEN_SHAPE_READ_RETRIES } });
      return;
    }

    // Entry filters gate the OPEN only. Context = local (open tokens) + leader-shape (range) + resolved data.
    const filterCtx: FilterContext = {
      openTokenMints: new Set(),
      priceRangePercent: rangeCoveragePercent(shape.perBin.length, meta.binStep),
      ...(await filterDataP),
    };
    const verdict = runFilters({ nonSolMint: e.nonSolMint, pool: e.pool }, filterCtx, ec.filters);
    if (filtersActive(ec.filters)) {
      log.info(
        {
          mint: e.nonSolMint,
          organicScore: filterCtx.organicScore,
          marketCapUsd: filterCtx.marketCapUsd,
          tokenAgeHours: filterCtx.tokenAgeHours,
          volume24hUsd: filterCtx.volume24hUsd,
          priceChangePercent: filterCtx.priceChangePercent,
          holders: filterCtx.holders,
          priceRangePercent: filterCtx.priceRangePercent,
          verdict: verdict.action,
          reason: verdict.action === 'skip' ? verdict.reason : undefined,
        },
        '🔎 entry filters evaluated',
      );
    }
    if (verdict.action === 'skip') {
      // An enabled filter ENFORCES (no shadow mode): the open is skipped with the failing filter's reason → its
      // `filter.<reason>` leaf (dynamic; 16 verbatim filter leaves, all feed/transparency — resolved per reason).
      emitFor(verdict.reason, { stage: 'open', outcome: 'skipped', reason: verdict.reason, leader: cfg.leader, pool: e.pool, leaderPosition: e.position, eventKey: openSkipKey(e), leaderSizeSol: e.depositSol, adminDetail: { mint: e.nonSolMint, nonSolSymbol: e.nonSolSymbol } });
      return;
    }

    // TWO-SIDED (flag-gated): if the leader's position holds a TOKEN leg, replicate BOTH sides (buy the token,
    // deposit two-sided). 'shadow' logs the plan but still opens SOL-only; 'off' (default) = SOL-side-only.
    if (ec.twoSidedMode !== 'off') {
      const legs = shape.perBin.map((b) => ({ binId: b.binId, solRaw: meta.solSide === 'Y' ? b.y : b.x, tokenRaw: meta.solSide === 'Y' ? b.x : b.y }));
      const plan = planTwoSided(legs, shape.activeBinId, shape.activeBinId, BigInt(ec.execution.dustTokenRaw));
      if (plan.twoSided && plan.leaderSolRaw > 0n && e.nonSolMint) {
        log.info({ mode: ec.twoSidedMode, leaderTokenRaw: plan.leaderTokenRaw.toString(), bins: plan.weights.length }, '🪙 two-sided position detected');
        // SAFE: a two-sided leader is copied as BOTH legs or NOT AT ALL — NEVER a half (one-sided) position. 'on'
        // hands off to openTwoSided, which either replicates both legs or SKIPS cleanly if the token can't be
        // bought (no Jupiter route). Either way we return — we do NOT fall through to the one-sided SOL path.
        if (ec.twoSidedMode === 'on') return openTwoSided(e, e.nonSolMint, meta.solSide, plan);
        // 'shadow' → fall through to the SOL-only path below (shadow mode = log the two-sided plan, open SOL-only).
      }
    }

    const perBinSol = shape.perBin.map((b) => ({ binId: b.binId, amount: meta.solSide === 'Y' ? b.y : b.x }));
    const reanchored = reanchorShape(shape.activeBinId, shape.activeBinId, perBinSol); // delta 0 = 100% exact bins
    // CONTIGUOUS span for the SDK by-weight open: a re-anchor that drops a tiny interior bin to 0 bps would leave a
    // binId gap → "Discontinuous Bin ID". Fill gaps with 0/0 (min/max unchanged, so targetBinRange stays correct).
    const dist: WeightBin[] = fillContiguousWeights(reanchored.weights.map((w) => ({ binId: w.binId, xBps: meta.solSide === 'X' ? w.bps : 0, yBps: meta.solSide === 'Y' ? w.bps : 0 })));

    const sizeLamports = BigInt(Math.round(decision.sizeSol * LAMPORTS_PER_SOL));
    const totalX = meta.solSide === 'X' ? sizeLamports : 0n;
    const totalY = meta.solSide === 'Y' ? sizeLamports : 0n;
    const lower = reanchored.lowerBinId;
    const upper = reanchored.upperBinId;
    // A WIDE one-sided open (≥26 bins) chunks the atomic by-weight open into [pre, main(addLiquidityOneSide), post].
    // The deposit (main) is NOT the first tx, so we sequence it: publish `pre` (create+wrap) then `main`+`post`
    // (deposit+unwrap) once the create lands (publishSplitOpen). The commandId is derived from `open-create:` so the
    // create's position keypair matches the one baked into the SDK build. Narrow opens (≤25) keep the atomic 1-tx path.
    const wide = isWideOpen(dist.length);
    const eventKey = wide ? `${cfg.leader}:${e.pool}:open-create:${e.signature}` : `${cfg.leader}:${e.pool}:open:${e.signature}`;
    const commandId = deriveCommandId(eventKey);
    const posKp: Keypair = derivePositionKeypair(commandId);
    const built = await buildOpenByWeight(conn, poolPk, ownerPk, posKp.publicKey, totalX, totalY, dist, pair);
    if (wide) {
      void slotsP.catch(() => undefined); // the parallel slot fetch is unused on this path; publishSplitOpen fetches its own
      const arr = Array.isArray(built) ? built : [built]; // ≥26 bins → [pre, main, post]
      return publishSplitOpen(e, { createTx: arr[0] as Transaction, depositTx: mergeDeposit(arr.slice(1)), posPubkey: posKp.publicKey.toBase58(), commandId, eventKey, lower, upper, sizeSol: decision.sizeSol });
    }
    const { issuedAtSlot, deadlineSlot } = await slotsP;
    const sr: Omit<SignRequest, 'issuedAtMs'> = {
      commandId,
      eventKey,
      kind: 'open',
      pool: e.pool,
      positionPubkey: posKp.publicKey.toBase58(),
      owner: ownerPk.toBase58(),
      txBase64: serializeUnsigned(onlyTx(built, 'open')),
      sizeSol: decision.sizeSol,
      targetBinRange: { lower, upper },
      issuedAtSlot,
      deadlineSlot,
    };
    const mirror = registry.open({ leaderPosition: e.position, ourPosition: sr.positionPubkey, pool: e.pool, nonSolSymbol: e.nonSolSymbol, sizeSol: decision.sizeSol, lowerBin: lower, upperBin: upper, openedAt: Date.now() });
    pendingOpens.clear(e.position); // now tracked → lift the duplicate-open reservation for this leader position
    await store.saveOpen(mirror); // persist BEFORE publishing → never an untracked open
    await publish(sr, { leaderPosition: e.position, leaderSizeSol: e.depositSol });
  }

  /** TWO-SIDED open: buy the token leg (ExactOut, deterministic) then deposit BOTH legs. Publishes the BUY first
   *  so the coffre lands it before the open (funds the token). The SOL leg keeps the sized SOL; the token leg is
   *  scaled by the SAME factor (our SOL / leader SOL) to preserve the leader's composition. */
  async function openTwoSided(e: DetectedEvent, tokenMint: string, solSide: 'X' | 'Y', plan: TwoSidedPlan): Promise<void> {
    const ec = eff();
    // Scale BOTH legs by copyRatio of the leader's respective legs (preserves composition), SOL leg capped.
    const { solLamports: sizeLamports, tokenTarget } = sizeTwoSided(plan.leaderSolRaw, plan.leaderTokenRaw, ec.sizing.tradeRatioPct ?? 100, BigInt(Math.round(ec.sizing.maxTradeSizeSol * LAMPORTS_PER_SOL)));
    const sizeSol = Number(sizeLamports) / LAMPORTS_PER_SOL;
    const dist: WeightBin[] = fillContiguousWeights(plan.weights.map((w) => ({ binId: w.binId, xBps: solSide === 'X' ? w.solBps : w.tokenBps, yBps: solSide === 'Y' ? w.solBps : w.tokenBps }))); // contiguous span (SDK by-weight requirement)
    // ExactIn buy: ExactOut has NO Jupiter route for most memecoins (NO_ROUTES_FOUND). Price the token leg via the
    // SELL direction (ExactIn, fully routed) → its SOL value → spend that to BUY the token (ExactIn). The token
    // received is variable, so the build-after-buy step deposits the ACTUAL balance (not a pre-planned exact amount).
    let buyQuote: Awaited<ReturnType<typeof getJupiterBuyQuoteExactIn>>;
    let buyTxB64: string;
    try {
      const priceQuote = await getJupiterQuote(cfg.jupiterBaseUrl, tokenMint, tokenTarget, ec.execution.slippageBps); // sell tokenTarget → its SOL value
      const solToSpend = BigInt(priceQuote.outAmount);
      if (!(solToSpend > 0n)) throw new Error('token leg priced at 0 SOL');
      buyQuote = await getJupiterBuyQuoteExactIn(cfg.jupiterBaseUrl, tokenMint, solToSpend, ec.execution.slippageBps);
      buyTxB64 = await buildJupiterSwapTx(cfg.jupiterBaseUrl, buyQuote, ownerPk.toBase58());
    } catch (err) {
      // SAFE: the token leg genuinely can't be acquired (no route EVEN via ExactIn, or a priced-at-0 leg). We do NOT
      // open a HALF (one-sided) position — SKIP entirely (nothing stashed/published yet → clean no-op).
      events.emit('eligibility.twosided.unbuyable', { stage: 'open', outcome: 'skipped', reason: 'twosided_unbuyable', leader: cfg.leader, pool: e.pool, leaderPosition: e.position, eventKey: openSkipKey(e), adminDetail: { mint: tokenMint, nonSolSymbol: e.nonSolSymbol, err: (err as Error).message } });
      return; // SAFE: never a partial/one-sided copy
    }
    const buyKey = `${cfg.leader}:${e.pool}:buy:${e.signature}`;
    const buyCommandId = deriveCommandId(buyKey);
    const { issuedAtSlot, deadlineSlot } = await slots();

    // Stash the open context → built+published once the buy lands; the build reads the ACTUAL token bought (ExactIn
    // output is variable) and deposits THAT, keyed by solSide/tokenMint (not a pre-planned exact amount).
    pendingTwoSidedOpens.set(buyCommandId, { e, dist, sizeLamports, solSide, tokenMint, sizeSol });
    inFlightBuyMints.set(tokenMint, Date.now()); // protect this bought token from the safety-sweep until it's deposited
    await publish({
      commandId: buyCommandId,
      eventKey: buyKey,
      kind: 'buy',
      pool: e.pool,
      positionPubkey: ownerPk.toBase58(), // n/a for a swap — Wall B binds to owner's ATA of the bought token
      owner: ownerPk.toBase58(),
      txBase64: buyTxB64,
      sizeSol: Number(buyQuote.inAmount) / LAMPORTS_PER_SOL, // the ExactIn SOL input (spend) → re-clamped against maxTradeSol by the coffre
      targetBinRange: { lower: 0, upper: 0 },
      issuedAtSlot,
      deadlineSlot,
      buy: { outputMint: tokenMint, exactOutAmountRaw: buyQuote.outAmount, maxInLamports: buyQuote.inAmount }, // expected token (informational) + the SOL input (cap)
    });
    log.info({ tokenMint, expectToken: buyQuote.outAmount, spendSol: Number(buyQuote.inAmount) / LAMPORTS_PER_SOL, solLamports: sizeLamports.toString(), bins: dist.length }, '🪙 two-sided BUY (ExactIn) published — the open follows once the buy lands');
  }

  /** Publish an open as TX1 createEmptyPosition (kind 'open') → TX2 addLiquidityByWeight2 (kind 'add'), sequenced via
   *  ev:executed (create lands → publishDepositAfterPositionCreated; deposit lands → finalizeToken2022Open persists the
   *  mirror). Used for every open that CANNOT be the atomic single-tx by-weight open: a Token-2022 two-sided open (v1
   *  deposit rejected on-chain) AND any wide open (≥26 bins, where the atomic open chunks and the deposit isn't the
   *  first tx). The mirror is persisted ONLY after the deposit lands, so a crash between the two leaves an UNTRACKED
   *  empty position the orphan-sweep auto-closes (no dormant position). Caller guarantees dist.length ≤ the single
   *  add2 chunk (≤70 bins). One-sided: one of totalX/totalY is 0; two-sided: both legs are funded (token bought first). */
  async function publishOpenViaCreateDeposit(
    e: DetectedEvent,
    pair: Awaited<ReturnType<typeof createDlmmPair>>,
    args: { dist: WeightBin[]; totalX: bigint; totalY: bigint; lower: number; upper: number; sizeSol: number },
  ): Promise<void> {
    const { dist, totalX, totalY, lower, upper, sizeSol } = args;
    const createEventKey = `${cfg.leader}:${e.pool}:open-create:${e.signature}`;
    const createCommandId = deriveCommandId(createEventKey);
    const posKp: Keypair = derivePositionKeypair(createCommandId); // the coffre signs 'open' with derivePositionKeypair(commandId) → MUST match
    const built = await buildCreateEmptyPosition(conn, new PublicKey(e.pool), ownerPk, posKp.publicKey, lower, upper, pair);
    const { issuedAtSlot, deadlineSlot } = await slots();
    pendingToken2022Deposits.set(createCommandId, { e, dist, totalX, totalY, lower, upper, sizeSol });
    buildingToken2022Positions.set(posKp.publicKey.toBase58(), Date.now()); // orphan-close grace until the deposit lands
    await publish(
      {
        commandId: createCommandId,
        eventKey: createEventKey,
        kind: 'open',
        pool: e.pool,
        positionPubkey: posKp.publicKey.toBase58(),
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(built), // create deploys no SOL → no CU-limit override needed
        sizeSol: 0, // position creation deploys no SOL; the deposit (TX2) deploys it
        targetBinRange: { lower, upper },
        issuedAtSlot,
        deadlineSlot,
      },
      { leaderPosition: e.position, leaderSizeSol: e.depositSol },
    );
    log.info({ our: posKp.publicKey.toBase58(), bins: dist.length }, '🔨 open via create+deposit published (deposit follows once the create lands)');
  }

  /** Publish a WIDE open (≥26 bins) via the SDK's NATIVE multi-tx split. The atomic by-weight open returns
   *  [pre, main, post]: TX1 = `pre` (create position + bin arrays + wrap SOL, kind 'open', position signer); TX2 =
   *  `main`+`post` merged (the deposit via the native addLiquidityOneSide / addLiquidityByWeight + unwrap leftover,
   *  kind 'add'). Sequenced via ev:executed → publishDepositAfterPositionCreated (uses the PREBUILT deposit) →
   *  finalizeToken2022Open persists the mirror. `main` is the SDK's native one-/two-sided deposit ix → correct bin
   *  placement (unlike add2, which is two-sided-only and deposits 0 for a one-sided leg on the wrong side of active).
   *  `commandId` is derived from `eventKey` BY THE CALLER so the create's position keypair matches `createTx`. */
  async function publishSplitOpen(
    e: DetectedEvent,
    args: { createTx: Transaction; depositTx: Transaction; posPubkey: string; commandId: string; eventKey: string; lower: number; upper: number; sizeSol: number },
  ): Promise<void> {
    const { createTx, depositTx, posPubkey, commandId, eventKey, lower, upper, sizeSol } = args;
    const { issuedAtSlot, deadlineSlot } = await slots();
    pendingToken2022Deposits.set(commandId, { e, lower, upper, sizeSol, prebuiltDeposit: depositTx });
    buildingToken2022Positions.set(posPubkey, Date.now()); // orphan-close grace until the deposit lands
    await publish(
      {
        commandId,
        eventKey,
        kind: 'open',
        pool: e.pool,
        positionPubkey: posPubkey,
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(withCuLimit(createTx, TWO_SIDED_CU_LIMIT)), // bin-array init can exceed the 200k CU default
        sizeSol, // `pre` wraps the full SOL → bounded by both the coffre re-clamp AND Wall B's wrap cap
        targetBinRange: { lower, upper },
        issuedAtSlot,
        deadlineSlot,
      },
      { leaderPosition: e.position, leaderSizeSol: e.depositSol },
    );
    log.info({ our: posPubkey, lower, upper }, '🔨 wide open CREATE published (split — deposit follows once the create lands)');
  }

  /** Build + publish the two-sided OPEN once its BUY has landed (token + ATA now exist → clean SDK build). Keyed
   *  by the buy's commandId; a no-op if there's no pending open (e.g. a reshape buy, which builds its add directly). */
  async function publishTwoSidedOpenAfterBuy(buyCommandId: string): Promise<void> {
    const ctx = pendingTwoSidedOpens.get(buyCommandId);
    if (!ctx) return;
    pendingTwoSidedOpens.delete(buyCommandId);
    const { e, dist, sizeLamports, solSide, tokenMint, sizeSol } = ctx;
    if (consumeOpenCancellation(e.position, e.pool)) return; // leader closed before the buy landed → don't open into an exited pool
    const poolPk = new PublicKey(e.pool);
    const pair = await createDlmmPair(conn, poolPk);
    // Deposit the token we ACTUALLY bought (ExactIn output is variable) — read the settled balance, don't assume an
    // exact amount. SOL leg = the sized lamports; token leg = the real balance, distributed by the same bps `dist`.
    const actualToken = depositableToken(await readOwnerTokenBalance(conn, ownerPk, new PublicKey(tokenMint))); // reserve a hair for per-bin bps rounding (TransferChecked insufficient-funds)
    const totalX = solSide === 'X' ? sizeLamports : actualToken;
    const totalY = solSide === 'Y' ? sizeLamports : actualToken;
    const lower = Math.min(...dist.map((d) => d.binId));
    const upper = Math.max(...dist.map((d) => d.binId));

    // TOKEN-2022 leg → the v1 by-weight open is rejected on-chain (token program pinned to classic). Split into TX1
    // createEmptyPosition (kind 'open') + TX2 addLiquidityByWeight2 (kind 'add'), sequenced via ev:executed. Both legs
    // span the active bin so the two-sided add2 deposits correctly. The mirror is persisted ONLY after the deposit
    // lands → a crash between the two leaves an UNTRACKED empty position the orphan-sweep auto-closes (no dormant).
    if (isToken2022Pool(pair)) {
      if (dist.length > TOKEN2022_MAX_OPEN_BINS) {
        // Wider than a single create + single add2 chunk → SKIP (never a partial deposit). The bought token is
        // recovered by the wallet sweep (sold back to SOL); a >70-bin two-sided memecoin copy is rare.
        events.emit('eligibility.twosided.token2022_too_wide', { stage: 'open', outcome: 'skipped', reason: 'twosided_token2022_too_wide', leader: cfg.leader, pool: e.pool, leaderPosition: e.position, eventKey: openSkipKey(e), adminDetail: { mint: tokenMint, nonSolSymbol: e.nonSolSymbol, bins: dist.length, max: TOKEN2022_MAX_OPEN_BINS } });
        return;
      }
      return publishOpenViaCreateDeposit(e, pair, { dist, totalX, totalY, lower, upper, sizeSol });
    }

    // CLASSIC SPL two-sided. WIDE (≥26 bins) → the atomic open chunks into [pre, main(addLiquidityByWeight), post] →
    // sequence it (publishSplitOpen) so the deposit isn't dropped. NARROW (≤25) → the atomic 1-tx open (token held now
    // → CU estimation works). v1 addLiquidityByWeight is correct for a CLASSIC two-sided deposit (both legs span active).
    const wide = isWideOpen(dist.length);
    const eventKey = wide ? `${cfg.leader}:${e.pool}:open-create:${e.signature}` : `${cfg.leader}:${e.pool}:open:${e.signature}`;
    const commandId = deriveCommandId(eventKey);
    const posKp: Keypair = derivePositionKeypair(commandId);
    const built = await buildOpenByWeight(conn, poolPk, ownerPk, posKp.publicKey, totalX, totalY, dist, pair);
    if (wide) {
      const arr = Array.isArray(built) ? built : [built]; // ≥26 bins → [pre, main, post]
      return publishSplitOpen(e, { createTx: arr[0] as Transaction, depositTx: mergeDeposit(arr.slice(1)), posPubkey: posKp.publicKey.toBase58(), commandId, eventKey, lower, upper, sizeSol });
    }
    const { issuedAtSlot, deadlineSlot } = await slots();
    const sr: Omit<SignRequest, 'issuedAtMs'> = {
      commandId,
      eventKey,
      kind: 'open',
      pool: e.pool,
      positionPubkey: posKp.publicKey.toBase58(),
      owner: ownerPk.toBase58(),
      txBase64: serializeUnsigned(withCuLimit(onlyTx(built, 'two-sided open'), TWO_SIDED_CU_LIMIT)),
      sizeSol,
      targetBinRange: { lower, upper },
      issuedAtSlot,
      deadlineSlot,
    };
    if (consumeOpenCancellation(e.position, e.pool)) return; // a close arrived DURING the build → abort before the on-chain publish
    const mirror = registry.open({ leaderPosition: e.position, ourPosition: sr.positionPubkey, pool: e.pool, nonSolSymbol: e.nonSolSymbol, sizeSol, lowerBin: lower, upperBin: upper, openedAt: Date.now() });
    pendingOpens.clear(e.position); // now tracked → lift the duplicate-open reservation for this leader position
    await store.saveOpen(mirror); // persist BEFORE publishing → never an untracked open
    await publish(sr, { leaderPosition: e.position, leaderSizeSol: e.depositSol });
    log.info({ our: sr.positionPubkey, bins: dist.length }, '🪙 two-sided OPEN published (after buy landed)');
  }

  /** TX2 of a Token-2022 two-sided open: once the empty position (TX1) has CONFIRMED on-chain, build + publish the
   *  exact-shape deposit via addLiquidityByWeight2 (kind 'add'). Keyed by the create's commandId; a no-op if there's
   *  no pending deposit. The mirror is persisted only after THIS lands (finalizeToken2022Open). */
  async function publishDepositAfterPositionCreated(createCommandId: string): Promise<void> {
    const ctx = pendingToken2022Deposits.get(createCommandId);
    if (!ctx) return;
    pendingToken2022Deposits.delete(createCommandId);
    const { e, lower, upper, sizeSol } = ctx;
    if (consumeOpenCancellation(e.position, e.pool)) return; // leader closed before the create landed → don't fund an exited pool (the empty position is orphan-closed)
    const poolPk = new PublicKey(e.pool);
    const posKp: Keypair = derivePositionKeypair(createCommandId); // SAME position the create made
    let depositTx: Transaction;
    if (ctx.prebuiltDeposit) {
      // SPLIT path (one-sided wide / classic-wide two-sided): the deposit (native addLiquidityOneSide / by-weight +
      // unwrap) was built ATOMICALLY with the create, so its accounts are already correct — publish it as-is.
      depositTx = ctx.prebuiltDeposit;
    } else {
      // REBUILD path (Token-2022 two-sided): addLiquidityByWeight2 fetches the positionV2 account → must build AFTER
      // the create lands. A transient "not yet readable" must not drop the deposit → retry the build.
      const pair = await createDlmmPair(conn, poolPk); // fresh: the position now exists on-chain
      let built: Transaction | Transaction[] | undefined;
      for (let r = 0; r < OPEN_SHAPE_READ_RETRIES && built === undefined; r++) {
        try {
          built = await buildAddByWeight(conn, poolPk, ownerPk, posKp.publicKey, ctx.totalX as bigint, ctx.totalY as bigint, ctx.dist as WeightBin[], pair);
        } catch (err) {
          if (r === OPEN_SHAPE_READ_RETRIES - 1) throw err;
          await sleep(OPEN_SHAPE_READ_DELAY_MS);
        }
      }
      // addLiquidityByWeight2 returns Transaction[]; ≤70 bins = a single chunk. More than one chunk would be a
      // PARTIAL deposit (shape mismatch) → abort (the empty position is then orphan-closed).
      const txs = Array.isArray(built) ? built : [built as Transaction];
      if (txs.length !== 1) throw new Error(`token2022 deposit chunked into ${txs.length} txs (range too wide) — aborting, no partial deposit`);
      depositTx = txs[0] as Transaction;
    }
    if (consumeOpenCancellation(e.position, e.pool)) return; // a close arrived DURING the deposit build → abort before the on-chain deposit
    const depositEventKey = `${cfg.leader}:${e.pool}:open-deposit:${e.signature}`;
    const depositCommandId = deriveCommandId(depositEventKey);
    const { issuedAtSlot, deadlineSlot } = await slots();
    pendingToken2022Mirrors.set(depositCommandId, { leaderPosition: e.position, ourPosition: posKp.publicKey.toBase58(), pool: e.pool, nonSolSymbol: e.nonSolSymbol, sizeSol, lower, upper, leaderSizeSol: e.depositSol });
    await publish(
      {
        commandId: depositCommandId,
        eventKey: depositEventKey,
        kind: 'add',
        pool: e.pool,
        positionPubkey: posKp.publicKey.toBase58(),
        owner: ownerPk.toBase58(),
        txBase64: serializeUnsigned(withCuLimit(depositTx, TWO_SIDED_CU_LIMIT)),
        sizeSol,
        targetBinRange: { lower, upper },
        issuedAtSlot,
        deadlineSlot,
      },
      { leaderPosition: e.position, leaderSizeSol: e.depositSol },
    );
    log.info({ our: posKp.publicKey.toBase58(), prebuilt: ctx.prebuiltDeposit !== undefined, lower, upper }, '🔨 open DEPOSIT published (position created → deposit)');
  }

  /** Finalize a Token-2022 two-sided open once its deposit (TX2) has landed: NOW persist the mirror (the position is
   *  funded + tracked) and lift the orphan-close grace. */
  async function finalizeToken2022Open(depositCommandId: string): Promise<void> {
    const pend = pendingToken2022Mirrors.get(depositCommandId);
    if (!pend) return;
    pendingToken2022Mirrors.delete(depositCommandId);
    if (consumeOpenCancellation(pend.leaderPosition, pend.pool)) {
      // Leader closed while the deposit was in flight. The deposit already landed (this is its confirm) → capital is
      // in the pool, but we do NOT register the mirror: lift the orphan-close grace so the reconcile/orphan sweep
      // closes the now-funded, untracked position and pulls the capital back out.
      buildingToken2022Positions.delete(pend.ourPosition);
      return;
    }
    const mirror = registry.open({ leaderPosition: pend.leaderPosition, ourPosition: pend.ourPosition, pool: pend.pool, nonSolSymbol: pend.nonSolSymbol, sizeSol: pend.sizeSol, lowerBin: pend.lower, upperBin: pend.upper, openedAt: Date.now() });
    pendingOpens.clear(pend.leaderPosition); // now tracked → lift the duplicate-open reservation for this leader position
    await store.saveOpen(mirror); // tracked only NOW — a funded, deposited position
    buildingToken2022Positions.delete(pend.ourPosition);
    // Token-2022 open is COMPLETE (deposit landed → mirror persisted) → emit the FEED `lifecycle.open_confirmed`,
    // the SAME confirm a classic open fires in onOpenConfirmed (the classic branch's ev:executed 'open' carries the
    // empty-position create, never the funded mirror, so it is excluded there). Observability-only.
    events.opened({ stage: 'open', outcome: 'confirmed', leader: cfg.leader, pool: mirror.pool, leaderPosition: mirror.leaderPosition, ourPosition: mirror.ourPosition, ourSizeSol: mirror.sizeSol, eventKey: openConfirmedKey(mirror.pool, mirror.ourPosition), adminDetail: { nonSolSymbol: mirror.nonSolSymbol, openCount: registry.openPositions().length } });
    log.info({ our: pend.ourPosition }, '🪙 two-sided Token-2022 OPEN complete (deposit landed → mirror persisted)');
  }

  /** Build + publish a two-sided RESHAPE ADD once its token BUY (ExactIn) has landed — deposit the ACTUAL bought
   *  amount (variable). Keyed by the reshape buy's commandId; a no-op if there's no pending reshape add. */
  async function publishReshapeAddAfterBuy(buyCommandId: string): Promise<void> {
    const ctx = pendingReshapeAdds.get(buyCommandId);
    if (!ctx) return;
    pendingReshapeAdds.delete(buyCommandId);
    const { dist, addLamports, solSide, tokenMint, lower, upper, totalAddSol, ourPosition, pool, leaderPosition, signature } = ctx;
    // A reshape ADD is on an EXISTING (registered) mirror — NOT an open, so a leader close finds the mirror and runs
    // the normal close path. But that close may land WHILE this add's buy was in flight: don't ADD liquidity to a
    // position the leader closed (registry.close flips its status). The bought token is recovered by the sweep.
    if (!registry.hasOpen(leaderPosition)) {
      events.emit('reshape.noop', { stage: 'reshape', outcome: 'noop', leader: cfg.leader, pool, leaderPosition, ourPosition, eventKey: `${cfg.leader}:${pool}:reshape-add-cancelled:${signature}`, adminDetail: { phase: 'mirror_closed_before_reshape_add' } });
      return;
    }
    const poolPk = new PublicKey(pool);
    const pair = await createDlmmPair(conn, poolPk);
    const actualToken = await readOwnerTokenBalance(conn, ownerPk, new PublicKey(tokenMint)); // ExactIn output is variable → deposit the real balance
    const depositToken = depositableToken(actualToken); // reserve a hair for per-bin bps rounding (else TransferChecked → insufficient funds)
    // TWO-SIDED add. WIDE (≥26 bins) → addLiquidityByWeight2 (v1 would chunk at 26 → onlyTx throw → the wide grow would
    // fail); fits ≤70 bins in one tx, works classic + Token-2022. NARROW (≤25) → keep the PROVEN buildAddByWeight (v1
    // classic / add2 Token-2022) untouched — exact per-bin placement (changing it perturbs precise spike/refill copies).
    const totalX = solSide === 'X' ? depositToken : addLamports;
    const totalY = solSide === 'Y' ? depositToken : addLamports;
    const built =
      dist.length >= ATOMIC_BY_WEIGHT_BIN_LIMIT
        ? await buildAddByWeight2(conn, poolPk, ownerPk, new PublicKey(ourPosition), totalX, totalY, dist, pair)
        : await buildAddByWeight(conn, poolPk, ownerPk, new PublicKey(ourPosition), totalX, totalY, dist, pair);
    const { issuedAtSlot, deadlineSlot } = await slots();
    const addKey = `${cfg.leader}:${pool}:reshape-add:${signature}`;
    await publish({ commandId: deriveCommandId(addKey), eventKey: addKey, kind: 'add', pool, positionPubkey: ourPosition, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(withCuLimit(onlyTx(built, 'reshape add (two-sided)'), TWO_SIDED_CU_LIMIT)), sizeSol: totalAddSol, targetBinRange: { lower, upper }, issuedAtSlot, deadlineSlot }, { stage: 'reshape', leaderPosition });
    log.info({ our: ourPosition, bins: dist.length }, '🪙 two-sided reshape ADD published (after buy landed)');
  }

  // A cancelled multi-tx open surfaces as the leader-closed FAILSAFE (SAME semantics as the reClose alias
  // `leader_closed` → `failsafe.activated`): the leader closed and we protected capital by NOT completing the open.
  // Feed-visible + deduped per leader position (distinct cancels stay distinct; a cross-path double-emit collapses).
  const openCancelledKey = (pool: string, leaderPosition: string): string => `${cfg.leader}:${pool}:open-cancelled:${leaderPosition}`;
  const emitOpenCancelled = (leaderPosition: string, pool: string, dropped: number): void => {
    events.emit('failsafe.activated', { stage: 'open', outcome: 'skipped', reason: 'leader_closed', leader: cfg.leader, pool, leaderPosition, eventKey: openCancelledKey(pool, leaderPosition), adminDetail: { phase: 'multi_tx_open_cancelled', dropped } });
  };
  const pendingOpenMapsView = (): PendingOpenMaps => ({ twoSidedOpens: pendingTwoSidedOpens, token2022Deposits: pendingToken2022Deposits, token2022Mirrors: pendingToken2022Mirrors, reshapeAdds: pendingReshapeAdds });
  // Does this leader position have any in-flight multi-tx open stash? (Belt-and-suspenders behind pendingOpens: a
  // stash can outlive the reservation's TTL if a buy/create never lands.)
  const hasPendingOpenStash = (leaderPosition: string): boolean => stashCount(pendingStashesFor(leaderPosition, pendingOpenMapsView())) > 0;

  // Cancel an IN-FLIGHT multi-tx open because the leader closed before it completed. Drops every pending-open stash
  // for this leader position across the 4 continuation maps, clears the duplicate-open reservation, and marks it in
  // `cancelledOpens` so a continuation ALREADY running (cross-path race: it resolved its stash before this ran)
  // aborts before publishing on-chain (see consumeOpenCancellation). There is nothing on-chain to close (the open
  // never landed); any token already bought is left to the periodic sweep (residual → sold back to SOL).
  function cancelPendingOpen(leaderPosition: string, pool: string): void {
    cancelledOpens.add(leaderPosition); // ALWAYS mark (also covers the race where a continuation already deleted its stash)
    const keys: PendingStashKeys = pendingStashesFor(leaderPosition, pendingOpenMapsView());
    for (const k of keys.twoSidedOpens) pendingTwoSidedOpens.delete(k);
    for (const k of keys.token2022Deposits) pendingToken2022Deposits.delete(k);
    for (const k of keys.token2022Mirrors) pendingToken2022Mirrors.delete(k);
    for (const k of keys.reshapeAdds) pendingReshapeAdds.delete(k);
    pendingOpens.clear(leaderPosition);
    // Emit ONLY when a real in-flight open was dropped. A stashCount of 0 with a reservation means either (a) a
    // SKIPPED open's leaked reservation (nothing was in flight → a "leader closed" alert would be misleading) or
    // (b) the RACE where a continuation already grabbed+deleted its stash — in that case the continuation's
    // `consumeOpenCancellation` emits instead (it always emits), so we still get exactly one row.
    const dropped = stashCount(keys);
    if (dropped > 0) emitOpenCancelled(leaderPosition, pool, dropped);
  }

  // Cross-path guard called INSIDE each multi-tx open continuation: if the leader closed (cancelPendingOpen marked
  // this leader position) WHILE the continuation was in flight, clear the reservation, forget the marker, emit, and
  // tell the caller to abort BEFORE publishing on-chain. Returns true iff the open was cancelled.
  function consumeOpenCancellation(leaderPosition: string, pool: string): boolean {
    if (!cancelledOpens.has(leaderPosition)) return false;
    cancelledOpens.delete(leaderPosition);
    pendingOpens.clear(leaderPosition);
    emitOpenCancelled(leaderPosition, pool, 0);
    return true;
  }

  async function handleClose(e: DetectedEvent): Promise<void> {
    const m = registry.get(e.position);
    if (!m) {
      // The mirror isn't registered → either an untracked position (ignore) OR a MULTI-TX open still IN FLIGHT
      // (buy→open / create→deposit / wide split) whose `registry.open` runs in a later ev:executed continuation. If
      // the leader CLOSED during that gap the in-flight open must be CANCELLED — else the continuation deploys
      // capital into the pool the leader just EXITED. Nothing is on-chain to close (the open never landed).
      if (pendingOpens.isPending(e.position) || hasPendingOpenStash(e.position)) cancelPendingOpen(e.position, e.pool);
      return;
    }
    const eventKey = `${cfg.leader}:${m.pool}:close:${e.signature}`;
    const built = await buildCloseTx(conn, new PublicKey(m.pool), ownerPk, new PublicKey(m.ourPosition), m.lowerBin, m.upperBin);
    const { issuedAtSlot, deadlineSlot } = await slots();
    registry.close(e.position); // in-memory fast path (caps/dedup); the DB is marked closed by the reconcile once confirmed on-chain
    await publish({ commandId: deriveCommandId(eventKey), eventKey, kind: 'close', pool: m.pool, positionPubkey: m.ourPosition, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(firstTx(built)), sizeSol: m.sizeSol, targetBinRange: { lower: m.lowerBin, upper: m.upperBin }, issuedAtSlot, deadlineSlot });
    recentlyPublishedClose.set(m.ourPosition, Date.now()); // grace: don't let the reconcile re-close while this is landing
  }

  async function handleClaim(e: DetectedEvent): Promise<void> {
    const m = registry.get(e.position);
    if (!m) return;
    const eventKey = `${cfg.leader}:${m.pool}:claim:${e.signature}`;
    const built = await buildClaimTx(conn, new PublicKey(m.pool), ownerPk, m.ourPosition);
    const { issuedAtSlot, deadlineSlot } = await slots();
    await publish({ commandId: deriveCommandId(eventKey), eventKey, kind: 'claim', pool: m.pool, positionPubkey: m.ourPosition, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(firstTx(built)), sizeSol: m.sizeSol, targetBinRange: { lower: m.lowerBin, upper: m.upperBin }, issuedAtSlot, deadlineSlot });
  }

  // The leader changed a position (add or partial remove) → RE-SYNC ours to the TARGET = copyRatio × leader's
  // CURRENT on-chain size (capped). Reads BOTH sizes on-chain so drift self-corrects and a missed event catches
  // up on the next one. A deadband (MIN_ADD_SOL) avoids churning on price-driven SOL-leg wiggle.
  async function handleResync(e: DetectedEvent): Promise<void> {
    const m = registry.get(e.position);
    if (!m) return;
    const ec = eff();
    const copyRatio = (ec.sizing.tradeRatioPct ?? 0) / 100; // re-sync target = ratio × leader current size (0/null = fixed-size → no resync)
    const poolPk = new PublicKey(m.pool);
    const meta = await poolReader.loadPoolMeta(m.pool);
    if (!meta?.solSide) {
      events.emit('eligibility.non_sol_paired', { stage: 'reshape', outcome: 'skipped', reason: 'non_sol_pool', leader: cfg.leader, pool: m.pool, leaderPosition: e.position, ourPosition: m.ourPosition, eventKey: reshapeSkipKey(e, m), adminDetail: { nonSolSymbol: m.nonSolSymbol } });
      return;
    }
    const solSide = meta.solSide;
    const pair = await createDlmmPair(conn, poolPk);
    // Stable read: a leader ADD/REMOVE we just saw may not be indexed yet → a premature read shows no change → we'd
    // skip the reshape (the copy wouldn't grow/shrink). readStableShape waits for the leader's liquidity to settle.
    // SHAPE-EXACT re-sync, aligned by offset-from-LOWER. A leader ADD/REMOVE seen via WS may not be indexed yet
    // (read-after-write lag) → a premature read shows no deficit → the copy wouldn't grow/shrink. When the event
    // carries a real change, RETRY the read+compute until a deficit appears (or retries exhausted = a genuine noop).
    const solOf = (b: { x: bigint; y: bigint }) => lamportsToSol(solSide === 'Y' ? b.y : b.x);
    const tokenOf = (b: { x: bigint; y: bigint }) => Number(solSide === 'Y' ? b.x : b.y); // RAW token units
    const changeExpected = e.depositSol > RESYNC_MIN_CHANGE_SOL || e.withdrawSol > RESYNC_MIN_CHANGE_SOL;
    let ourShape: Awaited<ReturnType<typeof readLeaderPositionShape>> = null;
    let plan: ReturnType<typeof planTwoSidedReshape> | null = null;
    let leaderBins: Array<{ offset: number; sol: number }> = []; // hoisted: also used post-loop for the new-size calc
    for (let r = 0; r <= (changeExpected ? RESYNC_READ_RETRIES : 0); r++) {
      if (r > 0) await sleep(OPEN_SHAPE_READ_DELAY_MS);
      const leaderShape = await readStableShape(poolPk, leaderPk, e.position, pair);
      if (!leaderShape) return; // leader gone → the reconcile closes ours
      const os = await readLeaderPositionShape(conn, poolPk, ownerPk, m.ourPosition, pair);
      if (!os) {
        events.emit('detect.not_on_chain_yet', { stage: 'reshape', outcome: 'skipped', reason: 'not_on_chain_yet', leader: cfg.leader, pool: m.pool, leaderPosition: e.position, ourPosition: m.ourPosition, eventKey: reshapeSkipKey(e, m) });
        return;
      }
      ourShape = os;
      leaderBins = leaderShape.perBin.map((b) => ({ offset: b.binId - leaderShape.lowerBinId, sol: solOf(b) }));
      const ourBins = os.perBin.map((b) => ({ offset: b.binId - os.lowerBinId, sol: solOf(b) }));
      const leaderTokenBins = leaderShape.perBin.map((b) => ({ offset: b.binId - leaderShape.lowerBinId, sol: tokenOf(b) }));
      const ourTokenBins = os.perBin.map((b) => ({ offset: b.binId - os.lowerBinId, sol: tokenOf(b) }));
      // SOL-leg ops (removes are proportional → cover both legs); token-leg ADD deficit handled two-sided when enabled.
      plan = planTwoSidedReshape(leaderBins, ourBins, leaderTokenBins, ourTokenBins, copyRatio, ec.sizing.maxTradeSizeSol, ec.execution.reshapeBinDeadbandSol, ec.execution.reshapeBinDeadbandToken);
      if (plan.ops.length > 0 || (ec.twoSidedMode === 'on' && plan.tokenAddOps.length > 0)) break; // deficit found → proceed
      // noop this read — if a change was expected, the leader event likely isn't indexed yet → retry
    }
    if (!ourShape || !plan) return;
    const { ops, tokenAddOps } = plan;
    const twoSidedAdd = ec.twoSidedMode === 'on' && tokenAddOps.length > 0;
    if (ops.length === 0 && !twoSidedAdd) {
      events.emit('reshape.noop', { stage: 'reshape', outcome: 'noop', leader: cfg.leader, pool: m.pool, leaderPosition: e.position, ourPosition: m.ourPosition, eventKey: reshapeSkipKey(e, m) });
      return;
    }

    const calls = reshapeToCalls(ops, ourShape.lowerBinId);
    // Our position's bin range is fixed at open; can't add outside it (leader extending its range = v1 limit).
    const adds = calls.adds.filter((a) => a.binId >= ourShape.lowerBinId && a.binId <= ourShape.upperBinId);
    if (adds.length < calls.adds.length) {
      events.emit('reshape.partial_range', { stage: 'reshape', outcome: 'skipped', reason: 'partial_range', leader: cfg.leader, pool: m.pool, leaderPosition: e.position, ourPosition: m.ourPosition, eventKey: reshapeSkipKey(e, m), adminDetail: { dropped: calls.adds.length - adds.length } });
    }

    const { issuedAtSlot, deadlineSlot } = await slots();
    // Removes first (free SOL), then ONE by-weight add. Each is its own idempotent cmd:sign.
    let rm = 0;
    for (const r of calls.removes) {
      const built = await buildRemovePartial(conn, poolPk, ownerPk, new PublicKey(m.ourPosition), r.fromBin, r.toBin, r.bps);
      const eventKey = `${cfg.leader}:${m.pool}:reshape-rm${rm}:${e.signature}`;
      await publish({ commandId: deriveCommandId(eventKey), eventKey, kind: 'remove', pool: m.pool, positionPubkey: m.ourPosition, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(firstTx(built)), sizeSol: 0, targetBinRange: { lower: r.fromBin, upper: r.toBin }, issuedAtSlot, deadlineSlot });
      rm++;
    }
    if (twoSidedAdd) {
      // TWO-SIDED reshape add: a deficit on the SOL leg AND the token leg → BUY the token deficit via ExactIn (ExactOut
      // has no Token-2022 route), then ADD both legs once the buy lands — the bought amount is variable, so we
      // build-after-buy and deposit the ACTUAL balance (exactly like the two-sided OPEN).
      const tokenMint = solSide === 'Y' ? meta.mintX : meta.mintY;
      const tokenAdds = tokenAddOps
        .map((o) => ({ binId: ourShape.lowerBinId + o.offset, raw: Math.round(o.addSol) }))
        .filter((a) => a.binId >= ourShape.lowerBinId && a.binId <= ourShape.upperBinId && a.raw > 0);
      const solShaped = adds.length > 0 ? reanchorShape(0, 0, adds.map((a) => ({ binId: a.binId, amount: BigInt(Math.round(a.addSol * LAMPORTS_PER_SOL)) }))) : null;
      const tokShaped = tokenAdds.length > 0 ? reanchorShape(0, 0, tokenAdds.map((a) => ({ binId: a.binId, amount: BigInt(a.raw) }))) : null;
      const byBin = new Map<number, WeightBin>();
      if (solShaped) for (const w of solShaped.weights) byBin.set(w.binId, { binId: w.binId, xBps: solSide === 'X' ? w.bps : 0, yBps: solSide === 'Y' ? w.bps : 0 });
      if (tokShaped)
        for (const w of tokShaped.weights) {
          const cur = byBin.get(w.binId) ?? { binId: w.binId, xBps: 0, yBps: 0 };
          if (solSide === 'X') cur.yBps = w.bps;
          else cur.xBps = w.bps;
          byBin.set(w.binId, cur);
        }
      // The SDK by-weight requires CONTIGUOUS binIds (a deadband-dropped per-bin add would leave a gap → it
      // errors "Discontinuous Bin ID"). Fill the [min,max] span with 0/0 entries so the listed bins are contiguous.
      const dist: WeightBin[] = fillContiguousWeights([...byBin.values()]);
      const totalAddSol = adds.reduce((s, a) => s + a.addSol, 0);
      const addLamports = BigInt(Math.round(totalAddSol * LAMPORTS_PER_SOL));
      const totalTokenRaw = BigInt(tokenAdds.reduce((s, a) => s + a.raw, 0));
      // Price the token target (sell direction, fully routed) → spend that SOL via ExactIn (output variable → the add
      // is built after the buy lands, reading the real balance). Skip cleanly if the token can't be priced/bought.
      try {
        const priceQuote = await getJupiterQuote(cfg.jupiterBaseUrl, tokenMint, totalTokenRaw, ec.execution.slippageBps);
        const solToSpend = BigInt(priceQuote.outAmount);
        if (!(solToSpend > 0n)) throw new Error('token leg priced at 0 SOL');
        const buyQuote = await getJupiterBuyQuoteExactIn(cfg.jupiterBaseUrl, tokenMint, solToSpend, ec.execution.slippageBps);
        const buyTxB64 = await buildJupiterSwapTx(cfg.jupiterBaseUrl, buyQuote, ownerPk.toBase58());
        const buyKey = `${cfg.leader}:${m.pool}:reshape-buy:${e.signature}`;
        const buyCommandId = deriveCommandId(buyKey);
        pendingReshapeAdds.set(buyCommandId, { dist, addLamports, solSide, tokenMint, lower: dist[0]!.binId, upper: dist.at(-1)!.binId, totalAddSol, ourPosition: m.ourPosition, pool: m.pool, leaderPosition: m.leaderPosition, signature: e.signature });
        inFlightBuyMints.set(tokenMint, Date.now()); // protect the bought token from the sweep until the reshape add deposits it
        await publish({ commandId: buyCommandId, eventKey: buyKey, kind: 'buy', pool: m.pool, positionPubkey: ownerPk.toBase58(), owner: ownerPk.toBase58(), txBase64: buyTxB64, sizeSol: Number(buyQuote.inAmount) / LAMPORTS_PER_SOL, targetBinRange: { lower: 0, upper: 0 }, issuedAtSlot, deadlineSlot, buy: { outputMint: tokenMint, exactOutAmountRaw: buyQuote.outAmount, maxInLamports: buyQuote.inAmount } }, { stage: 'reshape', leaderPosition: m.leaderPosition });
        log.info({ our: m.ourPosition, tokenMint, bins: dist.length }, '🪙 two-sided reshape BUY (ExactIn) published — the add follows once the buy lands');
      } catch (err) {
        // SAFE: can't acquire the token deficit → the SOL-leg removes already published stand; skip the token add (no
        // partial two-sided add). The reconcile self-corrects on the next leader event.
        events.emit('reshape.token_unbuyable', { stage: 'reshape', outcome: 'skipped', reason: 'reshape_token_unbuyable', leader: cfg.leader, pool: m.pool, leaderPosition: e.position, ourPosition: m.ourPosition, eventKey: reshapeSkipKey(e, m), adminDetail: { mint: tokenMint, nonSolSymbol: m.nonSolSymbol, err: (err as Error).message } });
      }
    } else if (adds.length > 0) {
      // A reshape ADD spanning ≥26 bins would chunk the SDK by-weight deposit into [pre, main, post] (deposit not the
      // first tx) → can't be one published tx. Split the deficit into ≤25-bin-span CHUNKS, each a self-contained
      // single-tx addLiquidityOneSide (wrap+deposit+unwrap), published INDEPENDENTLY (idempotent commandId, no
      // cross-tx dependency → landed in parallel). The copy grows by the FULL deficit. A narrow add = one chunk.
      const chunks = chunkBySpan(adds, ATOMIC_BY_WEIGHT_BIN_LIMIT - 1); // each chunk's bin span ≤ 25 → one tx
      let ci = 0;
      for (const chunk of chunks) {
        const chunkSol = chunk.reduce((s, a) => s + a.addSol, 0);
        const shaped = reanchorShape(0, 0, chunk.map((a) => ({ binId: a.binId, amount: BigInt(Math.round(a.addSol * LAMPORTS_PER_SOL)) }))); // delta 0: keep binIds, amounts → BPS (normalized within the chunk)
        // CONTIGUOUS span: a selective/deadband add (or a re-anchor that drops a tiny interior bin) leaves binId gaps;
        // the SDK by-weight rejects those ("Discontinuous Bin ID"). Fill them with 0/0 — same as the two-sided path.
        const dist: WeightBin[] = fillContiguousWeights(shaped.weights.map((w) => ({ binId: w.binId, xBps: solSide === 'X' ? w.bps : 0, yBps: solSide === 'Y' ? w.bps : 0 })));
        const chunkLamports = BigInt(Math.round(chunkSol * LAMPORTS_PER_SOL));
        const built = await buildAddByWeight(conn, poolPk, ownerPk, new PublicKey(m.ourPosition), solSide === 'X' ? chunkLamports : 0n, solSide === 'Y' ? chunkLamports : 0n, dist, pair);
        const eventKey = `${cfg.leader}:${m.pool}:reshape-add${ci}:${e.signature}`; // per-chunk key → distinct idempotent commands
        await publish({ commandId: deriveCommandId(eventKey), eventKey, kind: 'add', pool: m.pool, positionPubkey: m.ourPosition, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(onlyTx(built, 'reshape add chunk')), sizeSol: chunkSol, targetBinRange: { lower: dist[0]!.binId, upper: dist.at(-1)!.binId }, issuedAtSlot, deadlineSlot });
        ci++;
      }
    }

    const newSize = Math.min(copyRatio * leaderBins.reduce((s, b) => s + b.sol, 0), ec.sizing.maxTradeSizeSol);
    registry.adjustSize(e.position, newSize);
    await store.updateSize(e.position, newSize);
    log.info({ position: e.position, removes: calls.removes.length, adds: adds.length, newSize }, '🔧 reshape published (per-bin exact)');
  }

  // Anti-dormant reconcile (the no-miss-close pillar) — driven by ON-CHAIN reality, NEVER by DB status (which
  // can lie if a close failed). Enumerates OUR positions actually on-chain and compares to the persisted mirrors:
  //  · our position gone on-chain                  → close confirmed → mark closed in DB
  //  · our position still on-chain + leader closed  → re-publish the close (retried by the vault until it lands)
  //  · on-chain position we never tracked           → orphan → alert (never close blindly)
  // Any RPC failure aborts the sweep (retry next tick) so we never act on incomplete data.
  async function reconcileSweep(): Promise<void> {
    const tracked = await store.loadOpen();

    let held: UserPosition[];
    try {
      held = await readUserPositions(conn, ownerPk);
    } catch (e) {
      log.error({ e: (e as Error).message }, 'reconcile: failed to enumerate our positions → skip this sweep');
      return;
    }
    const ourOnChain = new Set(held.map((p) => p.position)); // enumerator → orphan detection ONLY (can lag)

    // Per-mirror DIRECT account reads — the RELIABLE close signal (a per-account getAccountInfo, not the laggy
    // enumerator): is OUR position gone? is the leader's? A read error → undefined → never added (no close on doubt).
    const ourClosed = new Set<string>();
    const leaderClosed = new Set<string>();
    await Promise.all(
      tracked.map(async (m) => {
        const [ours, leader] = await Promise.all([
          conn.getAccountInfo(new PublicKey(m.ourPosition)).catch(() => undefined),
          conn.getAccountInfo(new PublicKey(m.leaderPosition)).catch(() => undefined),
        ]);
        if (ours === null) ourClosed.add(m.ourPosition); // null = account gone (rent reclaimed on DLMM close)
        if (leader === null) leaderClosed.add(m.leaderPosition);
      }),
    );

    const now = Date.now();
    // Open-grace: a copy opened < RECONCILE_OPEN_GRACE_MS ago isn't reliably confirmable on-chain yet → exclude
    // it from close decisions so a fresh open is never mistaken for "gone" (anti-dormant regression).
    const recentlyOpened = new Set(tracked.filter((m) => now - m.openedAt < RECONCILE_OPEN_GRACE_MS).map((m) => m.ourPosition));

    const plan = planReconcile({
      ourOnChain,
      ourClosed,
      tracked: tracked.map((m) => ({ ourPosition: m.ourPosition, leaderPosition: m.leaderPosition })),
      leaderClosed,
      recentlyOpened,
      rugExitPending, // re-close a rug-SL-closed mirror (leader still open) until confirmed gone — never-miss-close
    });

    for (const our of plan.markClosed) {
      const m = tracked.find((x) => x.ourPosition === our);
      if (!m) continue;
      await store.markClosed(m.leaderPosition);
      registry.close(m.leaderPosition);
      recentlyPublishedClose.delete(our);
      rugSlTracker.forget(our);
      if (rugExitPending.delete(our)) void rugExitStore.savePending(rugExitPending); // rug-SL close CONFIRMED gone → stop retrying

      events.closed({ stage: 'close', outcome: 'confirmed', leader: cfg.leader, pool: m.pool, leaderPosition: m.leaderPosition, ourPosition: our, ourSizeSol: m.sizeSol, eventKey: closeConfirmedKey(m.pool, our), adminDetail: { nonSolSymbol: m.nonSolSymbol, via: 'reconcile' } });
    }
    for (const rc of plan.reClose) {
      // Grace: skip if we published a close for this position recently (let the in-flight close land first).
      if (now - (recentlyPublishedClose.get(rc.ourPosition) ?? 0) < RECLOSE_GRACE_MS) continue;
      const m = tracked.find((x) => x.ourPosition === rc.ourPosition);
      if (m) await publishReClose(m);
    }
    for (const orphan of plan.orphans) {
      // A Token-2022 open's empty position (TX1 landed, deposit TX2 still in flight) is intentionally UNTRACKED until
      // the deposit lands — don't orphan-close it mid-build. Past the grace (deposit never landed) the entry is
      // dropped and the empty position IS cleaned up here as a normal orphan (no dormant position).
      const buildingSince = buildingToken2022Positions.get(orphan);
      if (buildingSince !== undefined) {
        if (now - buildingSince < TOKEN2022_DEPOSIT_GRACE_MS) continue;
        buildingToken2022Positions.delete(orphan);
      }
      // Stray position on our wallet (a bug-forgotten mirror or a manual open) → AUTO-CLOSE it (spec 04
      // reconcile; Valhalla force-closes random DLMMs). We have its pool + bins from the enumerator. The grace
      // avoids re-publishing while a previous orphan-close is still landing.
      const p = held.find((h) => h.position === orphan);
      if (p && now - (recentlyPublishedClose.get(orphan) ?? 0) >= RECLOSE_GRACE_MS) await publishOrphanClose(p);
    }

    // Belt-and-suspenders (backstop behind the close-event-driven handleClose path): a leader that closed a position
    // whose MULTI-TX open is still IN FLIGHT is never in `tracked` (the mirror isn't registered yet), so the loops
    // above can't catch it. Cancel any pending open whose leader account is confirmably GONE so the continuation
    // never funds an exited pool — only when it's a CLEAN addition (leader account read as null; else rely on handleClose).
    const pendingLeaders = [...pendingOpenLeaders(pendingOpenMapsView())].filter(([lp]) => !registry.hasOpen(lp));
    if (pendingLeaders.length > 0) {
      await Promise.all(
        pendingLeaders.map(async ([lp, pool]) => {
          const info = await conn.getAccountInfo(new PublicKey(lp)).catch(() => undefined);
          if (info === null) cancelPendingOpen(lp, pool); // leader account gone → the pending open must not complete
        }),
      );
    }
  }

  // Publish a safety close for a tracked mirror (failsafe leader-closed, or rug-SL crash). Deterministic commandId
  // (per `tag`) → the vault retries it (idempotency re-claims a previously failed close) until it lands.
  async function publishSafetyClose(m: Mirror, tag: string, reason: string): Promise<void> {
    const eventKey = `${cfg.leader}:${m.pool}:${tag}:${m.leaderPosition}`;
    const built = await buildCloseTx(conn, new PublicKey(m.pool), ownerPk, new PublicKey(m.ourPosition), m.lowerBin, m.upperBin);
    const { issuedAtSlot, deadlineSlot } = await slots();
    await publish({ commandId: deriveCommandId(eventKey), eventKey, kind: 'close', pool: m.pool, positionPubkey: m.ourPosition, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(firstTx(built)), sizeSol: m.sizeSol, targetBinRange: { lower: m.lowerBin, upper: m.upperBin }, issuedAtSlot, deadlineSlot }, { stage: 'failsafe', severity: 'warn', reason, leaderPosition: m.leaderPosition });
    recentlyPublishedClose.set(m.ourPosition, Date.now()); // grace; journaled as a failsafe-published event in publish()
  }

  // Re-publish a failsafe close for a mirror still on-chain whose leader has closed.
  const publishReClose = (m: Mirror): Promise<void> => publishSafetyClose(m, 'failsafe', 'leader_closed');

  // Rug-SL: poll each open pool's active-bin token price (one cheap lbPair read per pool), feed the tracker, and
  // close any position whose price crashed ≥ dropPercent within the window. The leader keeps holding (it's OUR
  // independent safety exit) → close + drop the tracker window; re-copy only on a NEW leader open (no auto-reopen
  // path exists: planReconcile never opens, handleResync no-ops on a closed mirror). A failed price read yields
  // null → NOT recorded, so a transient RPC blip can never fabricate a crash.
  async function rugSlSweep(): Promise<void> {
    const open = registry.openPositions();
    if (open.length === 0) return;
    const now = Date.now();
    const byPool = new Map<string, Mirror[]>();
    for (const m of open) byPool.set(m.pool, [...(byPool.get(m.pool) ?? []), m]);
    for (const [pool, mirrors] of byPool) {
      const price = await readActiveTokenPrice(conn, new PublicKey(pool));
      if (price === null) continue; // never record a garbage price → no false trigger
      const rugCfg = eff().rugSl;
      for (const m of mirrors) {
        rugSlTracker.record(m.ourPosition, price, now);
        if (!rugCfg.enabled) continue;
        if (now - (recentlyPublishedClose.get(m.ourPosition) ?? 0) < RECLOSE_GRACE_MS) continue; // a close is already in flight
        if (!rugSlTracker.check(m.ourPosition, rugCfg, now)) continue;
        await publishSafetyClose(m, 'rugsl', 'rug_sl');
        // Keep the mirror TRACKED (do NOT registry.close here): a failed rug-SL close (congestion — the rug case)
        // must be re-published by the reconcile until the position is confirmed gone on-chain. Marking it
        // rug-exit-pending drives that retry independent of `leaderClosed` (the leader still holds it — rug-SL is OUR
        // exit). The reconcile clears the pending flag + registry.close + DB markClosed once the close lands.
        rugExitPending.add(m.ourPosition);
        void rugExitStore.savePending(rugExitPending); // persist so the retry survives a brain restart
        rugSlTracker.forget(m.ourPosition); // stop price re-triggering (recentlyPublishedClose + reconcile now own the retry)
        rugExited.add(m.leaderPosition); // suppress re-opening this leader position on its next add (we rug-exited it)
        void rugExitStore.save(rugExited); // persist so the suppression survives a brain restart
      }
    }
  }

  // Force-close a STRAY (untracked) position on our wallet — pool + bins come from the on-chain enumerator. The
  // close goes through the vault's Wall B like any other (signer/destination re-verified), so it can only ever
  // close OUR own position. Deterministic commandId → idempotent if it has to be retried.
  async function publishOrphanClose(p: UserPosition): Promise<void> {
    const eventKey = `${cfg.leader}:${p.pool}:orphan:${p.position}`;
    const built = await buildCloseTx(conn, new PublicKey(p.pool), ownerPk, new PublicKey(p.position), p.lowerBinId, p.upperBinId);
    const { issuedAtSlot, deadlineSlot } = await slots();
    const commandId = deriveCommandId(eventKey);
    await publish({ commandId, eventKey, kind: 'close', pool: p.pool, positionPubkey: p.position, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(firstTx(built)), sizeSol: 0, targetBinRange: { lower: p.lowerBinId, upper: p.upperBinId }, issuedAtSlot, deadlineSlot }, { stage: 'failsafe', reason: 'orphan' });
    recentlyPublishedClose.set(p.position, Date.now());
    // Orphan auto-close → the pinned, feed-visible `failsafe.orphan_closed` (was a generic `alert()`). Same
    // commandId as the publish marker above ⇒ the emit dedup collapses the two into ONE orphan-closed row.
    events.emit('failsafe.orphan_closed', { stage: 'failsafe', outcome: 'published', reason: 'orphan', leader: cfg.leader, pool: p.pool, ourPosition: p.position, commandId, eventKey, adminDetail: { position: p.position, pool: p.pool } });
  }

  // ev:executed(open) → a CLASSIC open LANDED on-chain: emit the FEED `lifecycle.open_confirmed` so the user sees
  // the open (the publish only emits the internal `lifecycle.open_published`). The mirror is already persisted at
  // publish time (no untracked open), so we look it up by OUR position. No-op if there's no mirror (e.g. a Token-2022
  // open's empty-position create lands here too — but those carry a pendingToken2022Deposits commandId and are routed
  // to the deposit step, never to this handler; the Token-2022 FEED confirm fires in finalizeToken2022Open instead).
  // Observability-only — never touches decision/tx-build/reconcile state.
  function onOpenConfirmed(ourPosition: string): void {
    const m = registry.getByOurPosition(ourPosition);
    if (!m) return;
    events.opened({ stage: 'open', outcome: 'confirmed', leader: cfg.leader, pool: m.pool, leaderPosition: m.leaderPosition, ourPosition, ourSizeSol: m.sizeSol, eventKey: openConfirmedKey(m.pool, ourPosition), adminDetail: { nonSolSymbol: m.nonSolSymbol, openCount: registry.openPositions().length } });
  }

  // ev:executed(add) → a reshape ADD leg LANDED → emit the FEED `lifecycle.add_confirmed` (the publish only emits the
  // internal `lifecycle.open_published` trace for a reshape add). The Token-2022 open's deposit also lands as kind
  // 'add' but carries a pendingToken2022Mirrors commandId and is routed to finalizeToken2022Open, never here. The
  // landed command's `commandId` (carried by the ev) is the correlation key → a duplicate confirm of the SAME add leg
  // collapses while distinct legs (distinct commandIds) stay distinct. Observability-only.
  function onAddConfirmed(ourPosition: string, commandId: string): void {
    const m = registry.getByOurPosition(ourPosition);
    if (!m) return;
    events.addedLiquidity({ stage: 'reshape', outcome: 'confirmed', leader: cfg.leader, pool: m.pool, leaderPosition: m.leaderPosition, ourPosition, ourSizeSol: m.sizeSol, commandId, adminDetail: { nonSolSymbol: m.nonSolSymbol } });
  }

  // ev:executed(claim) → a fees CLAIM LANDED → emit the FEED `lifecycle.claim_confirmed` (the publish only emits the
  // internal `lifecycle.open_published` trace). Correlation = the landed command's `commandId` (same-claim duplicate
  // confirms collapse; distinct claims stay distinct). Observability-only.
  function onClaimConfirmed(ourPosition: string, commandId: string): void {
    const m = registry.getByOurPosition(ourPosition);
    if (!m) return;
    events.claimed({ stage: 'close', outcome: 'confirmed', leader: cfg.leader, pool: m.pool, leaderPosition: m.leaderPosition, ourPosition, ourSizeSol: m.sizeSol, commandId, adminDetail: { nonSolSymbol: m.nonSolSymbol } }); // 'claim' maps to the close-domain stage (stageForKind)
  }

  // ev:executed(close) → the close LANDED, so our position is gone: mark the mirror closed in the DB NOW (don't
  // wait for the periodic reconcile, which the open-grace can defer up to ~grace+cadence). Orphan close (no
  // tracked mirror) → nothing to do. The reconcile + orphan-sweep stay the backstop if this ev was ever missed.
  async function onCloseConfirmed(ourPosition: string): Promise<void> {
    const m = registry.getByOurPosition(ourPosition);
    if (!m) return;
    await store.markClosed(m.leaderPosition);
    registry.close(m.leaderPosition);
    recentlyPublishedClose.delete(ourPosition);
    rugSlTracker.forget(ourPosition);
    events.closed({ stage: 'close', outcome: 'confirmed', leader: cfg.leader, pool: m.pool, leaderPosition: m.leaderPosition, ourPosition, ourSizeSol: m.sizeSol, eventKey: closeConfirmedKey(m.pool, ourPosition), adminDetail: { nonSolSymbol: m.nonSolSymbol, via: 'ev_executed' } });
  }

  // ev:executed(sell) → a residual token→SOL SELL (close-triggered OR safety-sweep) LANDED → emit the FEED
  // `swap.executed` ("Swapped X → SOL") so the user sees the residual sale. The sold token was stashed by
  // `publishSell` under this commandId (mint + symbol if known); we read+delete it here to name the token without
  // an extra RPC. No-op (defensive) if there's no stash (e.g. a sell from a prior process run, or a duplicate
  // confirm whose stash was already consumed). Correlation = the landed command's commandId. Observability-only;
  // never throws.
  function onSellConfirmed(ev: { commandId?: string; pool?: string; sig?: string }): void {
    if (!ev.commandId) return;
    const stash = pendingSellMints.get(ev.commandId);
    if (!stash) return; // unknown / already-confirmed sell → nothing to name
    pendingSellMints.delete(ev.commandId);
    events.swapped({ stage: 'sell', outcome: 'confirmed', kind: 'sell', leader: cfg.leader, pool: ev.pool ?? stash.pool, commandId: ev.commandId, signature: ev.sig, adminDetail: { nonSolSymbol: stash.nonSolSymbol, mint: stash.tokenMint, pool: ev.pool ?? stash.pool } });
  }

  // ev:executed feedback → fast residual sell. Once the vault confirms a CLOSE landed, the close returned SOL +
  // a residual non-SOL token; we immediately swap that residual back to SOL (Jupiter, built here → verified by
  // Wall B → signed by the vault). This is the FAST trigger — no waiting for the 30s reconcile.
  /** Build + publish a Jupiter token→SOL sell for `residualRaw` units of `tokenMint` (shared by the close-
   *  triggered residual sell and the wallet safety sweep). `source` only labels the event/log. `nonSolSymbol`
   *  (resolvable only on the close path, via the Mirror) names the token in the sell-confirm FEED line; null on
   *  the sweep path falls back to the truncated mint. Returns whether a sell was published (false = quote below
   *  the SOL-out floor). */
  async function publishSell(tokenMint: string, residualRaw: bigint, pool: string, source: 'close' | 'sweep', nonSolSymbol: string | null = null): Promise<boolean> {
    const t0 = Date.now();
    const ec = eff();
    const eventKey = `${cfg.leader}:${pool}:${source}:${tokenMint}:${residualRaw}`; // hoisted: also keys the below-min-sell-out skip's emit dedup
    const quote = await getJupiterQuote(cfg.jupiterBaseUrl, tokenMint, residualRaw, ec.execution.slippageBps);
    const minOut = minOutWithSlippage(BigInt(quote.outAmount), ec.execution.slippageBps);
    if (minOut < BigInt(ec.execution.minSellOutLamports)) {
      events.emit('swap.below_min_sell_out', { stage: 'sell', outcome: 'skipped', reason: 'below_min_sell_out', leader: cfg.leader, pool, eventKey, adminDetail: { mint: tokenMint, outAmount: quote.outAmount, source } });
      return false;
    }
    const txBase64 = await buildJupiterSwapTx(cfg.jupiterBaseUrl, quote, ownerPk.toBase58());

    const commandId = deriveCommandId(eventKey);
    // Stash the sold token keyed by the sell's commandId so the `ev:executed{kind:'sell'}` confirm can name it in
    // the FEED `swap.executed` line without an extra RPC (deleted on confirm; see onSellConfirmed). Set BEFORE the
    // publish so an instant confirm can never race ahead of the stash.
    pendingSellMints.set(commandId, { tokenMint, nonSolSymbol, pool });
    const { issuedAtSlot, deadlineSlot } = await slots();
    await publish({
      commandId,
      eventKey,
      kind: 'sell',
      pool,
      positionPubkey: ownerPk.toBase58(), // n/a for a sell — Wall B binds to owner's ATA of the input mint
      owner: ownerPk.toBase58(),
      txBase64,
      sizeSol: 0, // a sell deploys no SOL (it returns SOL)
      targetBinRange: { lower: 0, upper: 0 }, // n/a for a sell
      issuedAtSlot,
      deadlineSlot,
      sell: { inputMint: tokenMint, inputAmountRaw: residualRaw.toString(), minOutLamports: minOut.toString() },
    });
    log.info({ tokenMint, residual: residualRaw.toString(), outAmount: quote.outAmount, minOut: minOut.toString(), source, buildMs: Date.now() - t0 }, '💱 sell published');
    return true;
  }

  async function onCloseExecuted(ev: { pool: string; positionPubkey?: string }): Promise<void> {
    const meta = await poolReader.loadPoolMeta(ev.pool);
    if (!meta?.solSide) return; // non-SOL pool → nothing to re-swap into SOL
    const tokenMint = meta.solSide === 'X' ? meta.mintY : meta.mintX; // the non-SOL leg = residual to sell
    const residual = await readOwnerTokenBalance(conn, ownerPk, new PublicKey(tokenMint));
    const decision = decideResidualSell(residual, SELL_RESIDUAL_DUST_RAW); // sell ANY residual; minSellOutLamports gates economics post-quote
    if (!decision.sell) {
      // dynamic reason: `no_residual` → swap.no_residual (internal). (`dust` is unreachable here — the dust threshold
      // is 0 so a sub-dust balance is already `no_residual`; if it ever fired it would take the deterministic fallback.)
      emitFor(decision.reason, { stage: 'sell', outcome: 'skipped', reason: decision.reason, leader: cfg.leader, pool: ev.pool, eventKey: `${cfg.leader}:${ev.pool}:close-sell:${ev.positionPubkey ?? tokenMint}`, adminDetail: { mint: tokenMint } });
      return;
    }
    // Resolve the token symbol from the (now-closed) Mirror so the sell-confirm FEED line can name it (null → the
    // renderer truncates the mint). The Mirror still exists at close-confirm time (markClosed flips status, not the row).
    const closedMirror = ev.positionPubkey ? registry.getByOurPosition(ev.positionPubkey) : undefined;
    await publishSell(tokenMint, residual, ev.pool, 'close', closedMirror?.nonSolSymbol ?? null);
  }

  /** No-miss safety net: enumerate EVERY non-SOL token on the copier wallet (classic SPL + Token-2022) and sell
   *  each back to SOL. Catches anything the close-triggered sell missed — a brain downtime, a failed/rejected
   *  sell, or a residual from any other source — so the wallet never holds a dormant non-SOL balance. */
  async function sweepWallet(): Promise<void> {
    const balances = await readAllOwnerTokenBalances(conn, ownerPk);
    const swNow = Date.now();
    // Sweep ANY non-SOL (minSellOutLamports gates economics post-quote) — EXCEPT a token still in-flight for a
    // two-sided open (bought, awaiting deposit): selling it mid-open would empty the token leg. After the grace, a
    // still-present in-flight token means the open failed → it IS a stranded residual → swept.
    const toSweep = planWalletSweep(balances, WSOL_MINT, SELL_RESIDUAL_DUST_RAW).filter((b) => swNow - (inFlightBuyMints.get(b.mint) ?? 0) >= INFLIGHT_BUY_GRACE_MS);
    if (toSweep.length === 0) return;
    // `eventKey` is the per-cycle correlation (swNow): each periodic sweep that finds a residual is its own row
    // (the operator must see a still-stranded residual each cycle), while WS/poll have no part here. The per-mint
    // failure shares the cycle stamp + mint so a retry within the same cycle collapses, distinct cycles don't.
    events.emit('swap.sweep_detected', { stage: 'sweep', outcome: 'detected', leader: cfg.leader, eventKey: `${cfg.leader}:sweep:${swNow}`, adminDetail: { count: toSweep.length, mints: toSweep.map((b) => b.mint) } });
    for (const b of toSweep) {
      await publishSell(b.mint, b.amountRaw, ownerPk.toBase58(), 'sweep').catch((e) => {
        // A sweep sell that fails to build/publish is the swap-failed path → pinned, feed-visible (SPEC §2.1 swap).
        events.swapFailed({ stage: 'sweep', outcome: 'failed', reason: 'failed_after_retries', leader: cfg.leader, eventKey: `${cfg.leader}:sweep:${swNow}:${b.mint}`, adminDetail: { mint: b.mint, error: (e as Error).message } });
      });
    }
  }

  const onEvent = (e: DetectedEvent, source: EventSource): void => {
    // Dedup / tracker / replay-skip stay SYNCHRONOUS at enqueue time (the cursor+tracker state must advance in the
    // order events arrive, before any handler runs). `tracker.apply` returns null for a stale/duplicate leg.
    const pos = tracker.apply(e);
    log.debug({ source, position: e.position, instr: e.instruction, depositSol: e.depositSol, posNull: !pos }, '👁️ onEvent in');
    if (source === 'replay' || !pos) return; // mono-user: no copying of a past open (stale)
    const t0 = Date.now();
    // SERIALIZE per leader position: all handler work for ONE position runs strictly in order (no concurrent
    // handlers on the same position → no duplicate open). Route INSIDE the task (at dequeue time) so this event is
    // classified AFTER the prior same-position handler settled — its `registry.open`/pending reservation is visible.
    positionQueue.run(e.position, async () => {
      const kind = classifyInstruction(e.instruction);
      const ecRoute = eff();
      // tracked = already-open OR open-in-flight (pending reservation bridges the multi-tx open window) → a
      // follow-up add during an open routes to resync, never a 2nd open. `rugExited` ⇒ no re-open. Pure routing.
      const tracked = registry.hasOpen(e.position) || pendingOpens.isPending(e.position);
      const action = routeWithPending(e, {
        hasOpen: (p) => registry.hasOpen(p),
        isPendingOpen: (p) => pendingOpens.isPending(p),
        cfg: { infiniteAdd: ecRoute.infiniteAdd, claimFloorSol: ecRoute.claimFloorSol },
        rugExited: rugExited.has(e.position),
      });
      log.info({ source, position: e.position, kind, action, depositSol: e.depositSol, withdrawSol: e.withdrawSol, claimSol: e.claimSol, eventCount: pos.eventCount, tracked }, '👁️ event routed');
      if (action !== 'ignore') {
        // `eventKey` = the per-leg detection correlation (sig:position) so the emit dedup keys uniquely PER routed
        // leg — without it every routed event shares an empty correlation and the LRU would collapse them into one
        // row (a lost-detect regression). WS + cursor-poll re-observations of the SAME leg correctly collapse to one.
        void events.emit('detect.routed', { stage: 'detect', outcome: 'detected', kind: kind ?? undefined, leader: cfg.leader, pool: e.pool, leaderPosition: e.position, signature: e.signature, leaderSizeSol: e.depositSol || e.withdrawSol || e.claimSol, eventKey: `${e.signature}:${e.position}`, adminDetail: { action, instruction: e.instruction } });
      }
      // Reserve BEFORE handleOpen: a multi-tx open returns before `registry.open`, so without this a follow-up add
      // (a later serialized task) would see tracked=false and route to a 2nd open. Cleared at each registry.open site.
      if (action === 'open') pendingOpens.reserve(e.position);
      const act =
        action === 'open'
          ? handleOpen(e)
          : action === 'resync'
            ? handleResync(e)
            : action === 'close'
              ? handleClose(e)
              : action === 'claim'
                ? handleClaim(e)
                : null;
      if (act) {
        // AWAIT here so the queue holds the next same-position task until this handler SETTLES; preserve the
        // existing build+publish / mirror-error logging. The .catch keeps the task from rejecting → the queue
        // continues (a throwing task never blocks the position's next event).
        await act
          .then(() => {
            lastActionAt = Date.now();
            lastLatencyMs = Date.now() - t0;
            log.info({ kind, brainMs: lastLatencyMs }, '🧠 build+publish');
          })
          .catch((err) => log.error({ err: (err as Error).message }, 'mirror error'));
      }
    });
  };

  // A signature the detector could NOT resolve after the bounded retry → force-past to avoid stalling the
  // cursor, but emit a LOUD gap: a leader event may have been missed (the reconcile backstop still covers closes).
  const onGap = (signature: string, attempts: number): void => {
    events.emit('detect.gap', { stage: 'detect', outcome: 'failed', leader: cfg.leader, signature, eventKey: `gap:${signature}`, adminDetail: { attempts } });
  };
  const detector = new LeaderDetector(makeDetectionDeps({ conn, pk: leaderPk, poolReader, tokenMeta, onEvent, onGap }));
  await blockhashCache.start(); // prime + background-refresh so serializeUnsigned never pays a getLatestBlockhash RTT
  if (oracleOn()) {
    await priorityFeeOracle.start(); // prime + background-refresh the live fee estimate (opt-in)
    log.info('📈 priority-fee oracle on (live estimate raises the tier in congestion; cap still bounds it)');
  }

  // --once: validates the pipeline by forcing ONE open on a live leader position (deterministic), then exits.
  if (once) {
    await onceValidate(conn, leaderPk, poolReader, handleOpen, bus, hmacKey, log);
    await Promise.all([bus.quit(), control.quit()]);
    process.exit(0);
  }

  log.info({ leader: cfg.leader, owner: cfg.ownerPubkey, redis: cfg.redisUrl }, '🧠 brain started');
  await detector.poll('replay'); // sets the cursor + tracker state (without publishing)
  log.info('replay done — switching to live');

  // No-dormant-token: at boot, sweep any non-SOL balance left on the wallet (a prior downtime, a missed/
  // rejected close-sell) back to SOL before resuming — the wallet must never sit on a dormant token.
  await sweepWallet().catch((e) => events.system('system.sweep_failed', e, { stage: 'sweep', outcome: 'failed', reason: 'sweep_failed', leader: cfg.leader, adminDetail: { phase: 'boot' } }));

  // No-dormant: reload persisted open mirrors + immediate failsafe (the leader may have closed during a
  // brain downtime → we close right away whatever must be closed before even resuming live).
  const restored = await store.loadOpen();
  for (const m of restored) registry.open(m);
  if (restored.length > 0) {
    log.info({ restored: restored.length }, '♻️ mirrors reloaded from the DB');
    await reconcileSweep(); // close right away anything the leader closed during downtime (no grace at boot)
  }
  if (!cfg.wsUrl) {
    log.warn('no SOLANA_WS_URL → live impossible');
    await Promise.all([bus.quit(), control.quit()]);
    return;
  }
  const sub = new HeliusTxSubscriber(cfg.wsUrl, log);
  wsConnected = sub.isConnected(); // seed; the callback keeps it live (observability — status only)
  sub.onConnectionChange((c) => {
    wsConnected = c;
  });
  sub.onReconnect(() => detector.poll().catch((e) => log.error({ e: (e as Error).message }, 'catch-up poll')));
  sub.watch(cfg.leader, (sig, logs) => {
    const hasDlmm = logs.some((l) => l.includes(DLMM_PROGRAM_ID));
    log.debug({ sig, hasDlmm, nLogs: logs.length }, '📡 ws notif');
    if (hasDlmm) detector.onWsSignature(sig).catch((e) => log.error({ e: (e as Error).message }, 'ws'));
  });
  sub.start();
  const timer = setInterval(
    () =>
      detector
        .poll()
        .then(() => onDetectionSuccess('poll'))
        .catch((e) => {
          log.error({ e: (e as Error).message }, 'poll');
          onDetectionFailure('poll');
        }),
    POLL_MS,
  );
  const reconTimer = setInterval(
    () =>
      reconcileSweep()
        .then(() => onDetectionSuccess('reconcile'))
        .catch((e) => {
          log.error({ e: (e as Error).message }, 'reconcile');
          onDetectionFailure('reconcile');
        }),
    RECON_MS,
  );
  const sweepTimer = setInterval(() => sweepWallet().catch((e) => log.error({ e: (e as Error).message }, 'sweep')), SWEEP_MS);
  const rugSlTimer = setInterval(() => rugSlSweep().catch((e) => log.error({ e: (e as Error).message }, 'rug-sl')), RUG_SL_POLL_MS);
  // Live config reload. A web config edit publishes a control ping → reload from the DB NOW (kill-switch in <100ms);
  // the periodic poll is the backstop if a ping is ever missed. load() is fail-safe (defaults on corruption); these
  // are the only writes to runtimeConfig post-boot.
  const configTimer = setInterval(() => void reloadConfig(), CONFIG_POLL_MS);
  await control.subscribe(() => {
    log.info('🔁 control: config-changed → reloading config now');
    void reloadConfig();
  });
  // Process heartbeat: beat now (web sees the brain online immediately) then on an interval.
  void heartbeat.beat(brainStatus());
  const heartbeatTimer = setInterval(() => void heartbeat.beat(brainStatus()), HEARTBEAT_INTERVAL_MS);

  // ev:executed consumer on a SEPARATE Redis connection (a blocking XREAD must never stall publishes). Crash-proof.
  let stopped = false;
  const evBus = RedisBus.connect(cfg.redisUrl);
  await evBus.ensureGroup(EV_EXECUTED_STREAM, 'brain');
  // Per-message dispatch deps: each deferred-publish handler keeps its OWN domain-specific failure emit (open_failed /
  // add_failed / swap.failed) via an inline `.catch()` — those are terminal (the pending-map entry is already
  // consumed → a retry no-ops) so the message is still acked. `onCloseConfirmed` is passed WITHOUT a catch: a DB blip
  // in markClosed must REJECT so the batch guard leaves the close UNACKED for an idempotent PEL-drain retry (never
  // silently drop a close). See dispatch-executed.ts.
  const executedDeps: ExecutedBatchDeps = {
    onCloseConfirmed,
    onCloseExecuted: (ev) =>
      onCloseExecuted(ev).catch((e) =>
        // close-residual sell build/publish failed → the swap-failed path (pinned, feed "swap manually").
        events.swapFailed({ stage: 'sell', outcome: 'failed', reason: 'failed_after_retries', leader: cfg.leader, pool: ev.pool, commandId: ev.commandId, adminDetail: { error: (e as Error).message, pool: ev.pool } }),
      ),
    hasPendingReshapeAdd: (commandId) => pendingReshapeAdds.has(commandId),
    publishReshapeAddAfterBuy: (commandId) =>
      publishReshapeAddAfterBuy(commandId).catch((e) => events.emit('reshape.add_failed', { stage: 'reshape', outcome: 'failed', reason: 'add_failed', leader: cfg.leader, commandId, adminDetail: { error: (e as Error).message, commandId } })),
    publishTwoSidedOpenAfterBuy: (commandId) =>
      publishTwoSidedOpenAfterBuy(commandId).catch((e) => events.emit('lifecycle.open_failed', { stage: 'open', outcome: 'failed', reason: 'open_failed', leader: cfg.leader, commandId, adminDetail: { error: (e as Error).message, commandId } })),
    hasPendingToken2022Deposit: (commandId) => pendingToken2022Deposits.has(commandId),
    publishDepositAfterPositionCreated: (commandId) =>
      publishDepositAfterPositionCreated(commandId).catch((e) =>
        // the deposit leg of a Token-2022 OPEN failed to build/publish → the open did not complete (open_failed).
        events.emit('lifecycle.open_failed', { stage: 'open', outcome: 'failed', reason: 'open_failed', leader: cfg.leader, commandId, adminDetail: { error: (e as Error).message, commandId, leg: 'token2022_deposit' } }),
      ),
    onOpenConfirmed,
    hasPendingToken2022Mirror: (commandId) => pendingToken2022Mirrors.has(commandId),
    finalizeToken2022Open: (commandId) =>
      finalizeToken2022Open(commandId).catch((e) => events.emit('lifecycle.open_failed', { stage: 'open', outcome: 'failed', reason: 'open_failed', leader: cfg.leader, commandId, adminDetail: { error: (e as Error).message, commandId, leg: 'token2022_finalize' } })),
    onAddConfirmed,
    onClaimConfirmed,
    onSellConfirmed,
    ack: (id) => evBus.ack(EV_EXECUTED_STREAM, 'brain', id),
    onLoopError: (err, id) =>
      events.system('system.loop_errored', err, { stage: 'failsafe', outcome: 'failed', reason: 'loop_errored', leader: cfg.leader, adminDetail: { loop: 'ev_executed', id } }),
  };
  const consumeExecuted = async (): Promise<void> => {
    let backoff = 1000;
    while (!stopped) {
      try {
        // No-miss (mirrors coffre-main): drain the PEL FIRST — any message a prior iteration left delivered-but-
        // unACKed (a transient handler/ack throw, or a same-process restart) is re-processed here so a confirmation
        // (ESPECIALLY a close) is never stranded by `'>'` (which only returns NEW messages). On the first iteration
        // this also recovers a boot-time PEL. Then read new messages. Both go through the SAME per-message guard.
        await processExecutedBatch(await evBus.consumePending(EV_EXECUTED_STREAM, 'brain', 'brain-1', 'ev:executed', hmacKey, 100), executedDeps);
        await processExecutedBatch(await evBus.consume(EV_EXECUTED_STREAM, 'brain', 'brain-1', 'ev:executed', hmacKey, 10, 5000), executedDeps);
        backoff = 1000;
      } catch (e) {
        // CONNECTION-level failure only (a Redis-down consume/consumePending) — per-message errors are already
        // isolated inside processExecutedBatch. Record + exponential backoff + continue (Redis may recover).
        events.system('system.loop_errored', e, { stage: 'failsafe', outcome: 'failed', reason: 'loop_errored', leader: cfg.leader, adminDetail: { loop: 'ev_executed', backoff } });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };
  void consumeExecuted();

  const shutdown = async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    clearInterval(reconTimer);
    clearInterval(sweepTimer);
    clearInterval(rugSlTimer);
    clearInterval(configTimer);
    clearInterval(heartbeatTimer);
    blockhashCache.stop();
    sub.stop();
    await Promise.all([bus.quit(), evBus.quit(), control.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  if (autoStopSec > 0) setTimeout(() => void shutdown(), autoStopSec * 1000);
}

/** Forces an open on the most recent live leader position (deterministic validation of the brain). */
async function onceValidate(
  conn: Connection,
  leaderPk: PublicKey,
  poolReader: OnchainPoolMetaReader,
  handleOpen: (e: DetectedEvent) => Promise<void>,
  bus: RedisBus,
  hmacKey: string,
  logger: typeof log,
): Promise<void> {
  const sigs = (await conn.getSignaturesForAddress(leaderPk, { limit: 14 })).filter((s) => !s.err).map((s) => s.signature);
  const txs = await conn.getParsedTransactions(sigs, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  for (const tx of txs) {
    if (!tx?.meta?.logMessages?.some((l) => l.includes(DLMM_PROGRAM_ID))) continue;
    for (const leg of decodeDlmmLegs(tx)) {
      const meta = await poolReader.loadPoolMeta(leg.lbPair);
      if (!meta?.solSide || !leg.position) continue;
      const shape = await readLeaderPositionShape(conn, new PublicKey(leg.lbPair), leaderPk, leg.position);
      if (!shape) continue;
      const sym = meta.mintX === WSOL_MINT ? meta.mintY : meta.mintX;
      logger.info({ pool: leg.lbPair, position: leg.position }, '--once: forced open on live position');
      await handleOpen({ signature: `once-${leg.position}`, blockTime: 1, instruction: 'AddLiquidityByStrategy2', depositSol: 0.5, withdrawSol: 0, claimSol: 0, closed: false, pool: leg.lbPair, position: leg.position, nonSolMint: sym, nonSolSymbol: null });
      // re-read the stream to prove the publication
      const msgs = await bus.consume('copybot:cmd:sign', 'validate', 'v1', 'cmd:sign', hmacKey, 5, 2000).catch(() => []);
      logger.info({ consumed: msgs.length, ok: msgs[0]?.payload != null }, '--once: re-read from the bus');
      return;
    }
  }
  logger.warn('--once: no live leader position found');
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, 'brain fatal');
  process.exit(1);
});
