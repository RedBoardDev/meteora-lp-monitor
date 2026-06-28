/**
 * Copy-bot · Inc.2 — BRAIN process (NO keys, NO inbound socket). Detects the leader's DLMM events →
 * decides (sizing/caps, no filters in v1) → BUILDS the tx (SDK: FAITHFUL re-anchored open by-weight / close /
 * claim) → PUBLISHES a `SignRequest` on `cmd:sign` (Redis bus, HMAC). The vault signs+lands (separate process).
 *
 * Bundled CJS (tsup.copybot.config.ts) — imports the SDK, NEVER runs under tsx. Does NOT import the keypair.
 *   yarn tsup --config tsup.copybot.config.ts → node --env-file=../.env dist/copybot/brain-main.cjs [--once] [--seconds=N]
 */
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { Connection, type Keypair, PublicKey, type Transaction } from '@solana/web3.js';
import { pino } from 'pino';
import { type CapsState, checkCaps } from '@/domain/copybot/caps';
import { type SignRequest, SignRequestSchema } from '@/domain/copybot/contracts';
import { decideEntry } from '@/domain/copybot/decision';
import { classifyEventAction } from '@/domain/copybot/dispatch';
import type { DetectedEvent } from '@/domain/copybot/events';
import { type JournalEntry, stageForKind } from '@/domain/copybot/journal';
import { RugSlTracker } from '@/domain/copybot/rug-sl';
import { type EffectiveConfig, effectiveFor, withEnvOverride } from '@/domain/copybot/config';

import { type FilterContext, filtersActive, neededSources, rangeCoveragePercent, resolveFilterContext, runFilters, type TokenSnapshot } from '@/domain/copybot/filters';
import { JupiterTokenGateway } from '@/domain/copybot/filters/sources/jupiter-token/jupiter-token-gateway';
import { TtlCache } from '@/domain/copybot/ttl-cache';
import { type EventSource, LeaderDetector } from '@/domain/copybot/leader-detector';
import { LeaderPositionTracker } from '@/domain/copybot/leader-position';
import { lamportsToSol, reshapeToCalls } from '@/domain/copybot/position-adjust';
import { reanchorShape } from '@/domain/copybot/reanchor';
import { type TwoSidedPlan, planTwoSided, planTwoSidedReshape, sizeTwoSided } from '@/domain/copybot/two-sided';
import { planReconcile } from '@/domain/copybot/reconciliation';
import { decideResidualSell, minOutWithSlippage, planWalletSweep } from '@/domain/copybot/residual-sell';
import { classifyInstruction } from '@/domain/dlmm';
import { RedisBus } from '@/infrastructure/bus/redis-bus';
import { ControlChannel } from '@/infrastructure/bus/control-channel';
import { openDatabase } from '@/infrastructure/persistence/database';
import { decodeDlmmLegs } from '@/infrastructure/solana/dlmm/dlmm-event-decoder';
import { type WeightBin, buildAddByWeight, buildClaimTx, buildCloseTx, buildOpenByWeight, buildRemovePartial, createDlmmPair } from '@/infrastructure/solana/dlmm/dlmm-tx-builder';
import { readLeaderPositionShape, type UserPosition, readUserPositions } from '@/infrastructure/solana/dlmm/leader-position-reader';
import { readActiveTokenPrice } from '@/infrastructure/solana/dlmm/active-bin-price';
import { OnchainPoolMetaReader } from '@/infrastructure/solana/dlmm/pool-meta';
import { DEFAULT_JUPITER_BASE_URL, WSOL_MINT, buildJupiterSwapTx, getJupiterBuyQuote, getJupiterQuote } from '@/infrastructure/solana/jupiter/jupiter-swap-builder';
import { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';
import { HeliusTxSubscriber } from '@/infrastructure/solana/helius-tx-subscriber';
import { readAllOwnerTokenBalances, readOwnerTokenBalance } from '@/infrastructure/solana/token-balance-reader';
import { HeliusTokenMetadataGateway } from '@/infrastructure/solana/token-metadata-gateway';
import { alert } from '@/copybot/alert';
import { ConfigStore } from '@/copybot/config-store';
import { CopyJournalStore } from '@/copybot/journal-store';
import { HeartbeatStore } from '@/copybot/heartbeat-store';
import { type BrainStatusDetail, HEARTBEAT_INTERVAL_MS } from '@/domain/copybot/status';
import { deriveCommandId } from '@/copybot/command-id';
import { makeDetectionDeps } from '@/copybot/detection';
import { derivePositionKeypair } from '@/copybot/ephemeral-position';
import { envEffectiveOverride } from './env-overrides';
import { applyPriorityFee, withCuLimit } from './compute-budget';
import { type Mirror, MirrorRegistry } from './mirror-registry';
import { MirrorStore } from './mirror-store';

const STREAM = 'copybot:cmd:sign';
const HOP = 'cmd:sign';
const POLL_MS = 15_000;
const RECON_MS = 30_000; // on-chain reconcile cadence (no-miss-close backstop)
const RECLOSE_GRACE_MS = 60_000; // wait this long after publishing a close before a reconcile re-close (let it land)
const RECONCILE_OPEN_GRACE_MS = Number(process.env.RECONCILE_OPEN_GRACE_MS ?? '30000'); // a just-opened copy may be unconfirmed for ~1-2s (direct getAccountInfo) → skip the 1st reconcile tick after open; 30s = generous margin, minimal backstop delay (anti false-close → no-dormant)
const DEADLINE_SLOTS = 150; // ~60s
// Swap/reshape execution tunables now live in the runtime config (eff().execution) — see config/defaults.ts.
const SWEEP_MS = Number(process.env.SWEEP_MS ?? '60000'); // wallet token→SOL safety-sweep cadence (SYSTEM): the no-miss backstop behind the close-triggered sell (catches any dormant non-SOL left by downtime/a missed close)
const EV_EXECUTED_STREAM = 'copybot:ev:executed';
const RUG_SL_POLL_MS = 15_000; // rug-SL price-poll cadence: ~4 samples per a 60s window — fast enough to catch a crash, one lbPair read per open pool (economical)
const RUG_SL_RETAIN_MS = 180_000; // keep ≥ any sane windowSeconds so the detector always has its full lookback
const CONFIG_POLL_MS = 5_000; // re-read the DB-backed runtime config (sizing/caps/two-sided) so web edits apply live
const SNAPSHOT_TTL_MS = 30_000; // per-mint filter-snapshot cache TTL (short; pre-warm makes repeat opens free)
const FILTER_TIMEOUT_MS = 800; // hard cap on the filter-data fetch so a slow Jupiter never blocks the open

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const cfg = {
  httpUrl: process.env.SOLANA_HTTP_URL ?? '',
  wsUrl: process.env.SOLANA_WS_URL,
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6385',
  dbUrl: process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora',
  hmacKey: process.env.BUS_HMAC_KEY ?? 'dev-k-sign-CHANGE-ME',
  leader: process.env.COPYBOT_LEADER ?? '8ryctvNwpJTuuap3wuNTfcyEx4DjSuXvhGXSDHNaU8sQ',
  ownerPubkey: process.env.COPIER_OWNER ?? 'Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz',
  balanceSol: Number(process.env.COPIER_BALANCE_SOL ?? '10'),
  jupiterBaseUrl: process.env.JUPITER_BASE_URL ?? DEFAULT_JUPITER_BASE_URL,
};
// Sizing/caps/two-sided/filters all come from the DB-backed config (config-store), resolved per leader via eff().
// The env override (migration bridge) is SPARSE: a var, WHEN SET, takes precedence (preserves the on-chain bench);
// an UNSET var falls through to the DB config so it stays authoritative in production.
const ENV_EFFECTIVE_OVERRIDE = envEffectiveOverride(process.env);

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const firstTx = (t: Transaction | Transaction[]): Transaction => (Array.isArray(t) ? (t[0] as Transaction) : t);

// A two-sided open/add builds a tx that DEPOSITS token the copier doesn't hold yet (the BUY lands first, in the
// coffre). The SDK's compute-unit estimation SIMULATES that deposit → fails "insufficient funds" → the tx ships
// with no/low CU limit → fails on-chain. Force an explicit CU limit so the build never depends on that estimation.
const TWO_SIDED_CU_LIMIT = 1_400_000; // max CU cap (free — only used CU is metered): a wide 17-bin two-sided open/add needs >400k; the build's own estimation fails (token not held yet)

// BUILD-AFTER-BUY: a two-sided OPEN can't be built before the token is bought — the copier's token ATA doesn't
// even exist yet, so the SDK build produces a tx that fails on-chain. We publish the BUY, stash the open context
// here keyed by the buy's commandId, and build+publish the open only when the buy's ev:executed arrives (token +
// ATA now present → clean build). (A two-sided reshape ADD does NOT need this — its position's ATA already exists.)
const pendingTwoSidedOpens = new Map<string, { e: DetectedEvent; dist: WeightBin[]; totalX: bigint; totalY: bigint; sizeSol: number }>();

async function main(): Promise<void> {
  if (!cfg.httpUrl) {
    log.error('SOLANA_HTTP_URL missing');
    process.exit(1);
  }
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
  const journal = new CopyJournalStore(db, log, 'brain'); // activity journal (fail-safe; never blocks the hot path)
  const configStore = new ConfigStore(db, log);
  let runtimeConfig = await configStore.seedIfAbsent(); // the CopybotConfig blob; polled + ping-reloaded live below
  const reloadConfig = async (): Promise<void> => {
    runtimeConfig = await configStore.load();
  };
  // Resolve the EFFECTIVE config for our (single) leader, then apply the env/bench override (migration bridge).
  // Pure + cheap → recomputed at each point of use so a live reload always takes effect on the next event.
  const eff = (): EffectiveConfig => withEnvOverride(effectiveFor(runtimeConfig, cfg.leader), ENV_EFFECTIVE_OVERRIDE);
  const rugSlTracker = new RugSlTracker(RUG_SL_RETAIN_MS); // per-position price windows for the rug-SL crash check
  const control = ControlChannel.connect(cfg.redisUrl); // instant config-reload pings (kill-switch applies in <100ms)
  const heartbeat = new HeartbeatStore(db, log, 'brain'); // process status the web reads (online + positions/exposure/latency)
  let lastActionAt: number | null = null; // ms of the last build+publish (status snapshot)
  let lastLatencyMs: number | null = null; // brainMs of that last action
  const brainStatus = (): BrainStatusDetail => {
    const open = registry.openPositions();
    return { leader: cfg.leader, openPositions: open.length, exposureSol: open.reduce((s, m) => s + m.sizeSol, 0), lastActionAt, lastLatencyMs };
  };
  const recentlyPublishedClose = new Map<string, number>(); // ourPosition → ms a close was last published (reClose grace)
  const blockhashCache = new BlockhashCache(async () => (await conn.getLatestBlockhash()).blockhash);
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
    const id = await bus.publish(STREAM, HOP, cfg.hmacKey, full);
    // Activity journal: EVERY published intent is recorded once here (single backstop) → the store emits the clean
    // log line. Context-specific publishes (a failsafe/orphan re-close, a reshape-funding buy) pass a hint to
    // override stage/severity/leaderPosition.
    void journal.record({
      stage: stageForKind(full.kind),
      outcome: 'published',
      kind: full.kind,
      leader: cfg.leader,
      pool: full.pool,
      ourPosition: full.positionPubkey,
      commandId: full.commandId,
      eventKey: full.eventKey,
      ourSizeSol: full.sizeSol,
      detail: { targetBinRange: full.targetBinRange, streamId: id },
      ...journalHint,
    });
  }

  function serializeUnsigned(tx: Transaction): string {
    tx.feePayer = ownerPk;
    tx.recentBlockhash = blockhashCache.get(); // cached: the vault re-sets a fresh one before signing → no hot-path RTT
    applyPriorityFee(tx, eff().priorityFee); // capped priority fee on every DLMM tx (Wall B allows ComputeBudget)
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }

  async function slots(): Promise<{ issuedAtSlot: number; deadlineSlot: number }> {
    const s = await conn.getSlot();
    return { issuedAtSlot: s, deadlineSlot: s + DEADLINE_SLOTS };
  }

  async function handleOpen(e: DetectedEvent): Promise<void> {
    log.info({ position: e.position, pool: e.pool, depositSol: e.depositSol }, '🔨 handleOpen start');
    const ec = eff();
    const decision = decideEntry(e, { ...ec.sizing, skipNonSolPaired: true }, { availableBalanceSol: cfg.balanceSol });
    if (decision.outcome === 'skipped') {
      void journal.record({ stage: 'open', outcome: 'skipped', reason: decision.reason, leader: cfg.leader, pool: e.pool, leaderPosition: e.position, leaderSizeSol: e.depositSol });
      return;
    }
    const cap = checkCaps(ec.caps, capsState(), decision.sizeSol, Date.now());
    if (cap.action === 'block') {
      void journal.record({ stage: 'open', outcome: 'blocked', reason: cap.reason, leader: cfg.leader, pool: e.pool, leaderPosition: e.position, leaderSizeSol: e.depositSol, ourSizeSol: decision.sizeSol });
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
      void journal.record({ stage: 'open', outcome: 'skipped', reason: 'non_sol_pool', leader: cfg.leader, pool: e.pool, leaderPosition: e.position });
      return;
    }

    const pair = await pairP;
    const shape = await readLeaderPositionShape(conn, poolPk, leaderPk, e.position, pair);
    if (!shape) {
      void journal.record({ stage: 'open', outcome: 'skipped', reason: 'leader_position_not_found', leader: cfg.leader, pool: e.pool, leaderPosition: e.position });
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
      // An enabled filter ENFORCES (no shadow mode): the open is skipped and journaled with the failing filter's reason.
      void journal.record({ stage: 'open', outcome: 'skipped', reason: verdict.reason, leader: cfg.leader, pool: e.pool, leaderPosition: e.position, leaderSizeSol: e.depositSol, detail: { mint: e.nonSolMint } });
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
    const dist: WeightBin[] = reanchored.weights.map((w) => ({ binId: w.binId, xBps: meta.solSide === 'X' ? w.bps : 0, yBps: meta.solSide === 'Y' ? w.bps : 0 }));

    const eventKey = `${cfg.leader}:${e.pool}:open:${e.signature}`;
    const commandId = deriveCommandId(eventKey);
    const posKp: Keypair = derivePositionKeypair(commandId);
    const sizeLamports = BigInt(Math.round(decision.sizeSol * 1e9));
    const built = await buildOpenByWeight(conn, poolPk, ownerPk, posKp.publicKey, meta.solSide === 'X' ? sizeLamports : 0n, meta.solSide === 'Y' ? sizeLamports : 0n, dist, pair);
    const { issuedAtSlot, deadlineSlot } = await slotsP;
    const sr: Omit<SignRequest, 'issuedAtMs'> = {
      commandId,
      eventKey,
      kind: 'open',
      pool: e.pool,
      positionPubkey: posKp.publicKey.toBase58(),
      owner: ownerPk.toBase58(),
      txBase64: serializeUnsigned(firstTx(built)),
      sizeSol: decision.sizeSol,
      targetBinRange: { lower: reanchored.lowerBinId, upper: reanchored.upperBinId },
      issuedAtSlot,
      deadlineSlot,
    };
    const mirror = registry.open({ leaderPosition: e.position, ourPosition: sr.positionPubkey, pool: e.pool, nonSolSymbol: e.nonSolSymbol, sizeSol: decision.sizeSol, lowerBin: reanchored.lowerBinId, upperBin: reanchored.upperBinId, openedAt: Date.now() });
    await store.saveOpen(mirror); // persist BEFORE publishing → never an untracked open
    await publish(sr, { leaderPosition: e.position, leaderSizeSol: e.depositSol });
  }

  /** TWO-SIDED open: buy the token leg (ExactOut, deterministic) then deposit BOTH legs. Publishes the BUY first
   *  so the coffre lands it before the open (funds the token). The SOL leg keeps the sized SOL; the token leg is
   *  scaled by the SAME factor (our SOL / leader SOL) to preserve the leader's composition. */
  async function openTwoSided(e: DetectedEvent, tokenMint: string, solSide: 'X' | 'Y', plan: TwoSidedPlan): Promise<void> {
    const ec = eff();
    // Scale BOTH legs by copyRatio of the leader's respective legs (preserves composition), SOL leg capped.
    const { solLamports: sizeLamports, tokenTarget } = sizeTwoSided(plan.leaderSolRaw, plan.leaderTokenRaw, ec.sizing.tradeRatioPct ?? 100, BigInt(Math.round(ec.sizing.maxTradeSizeSol * 1e9)));
    const sizeSol = Number(sizeLamports) / 1e9;
    const dist: WeightBin[] = plan.weights.map((w) => ({ binId: w.binId, xBps: solSide === 'X' ? w.solBps : w.tokenBps, yBps: solSide === 'Y' ? w.solBps : w.tokenBps }));
    const totalX = solSide === 'X' ? sizeLamports : tokenTarget;
    const totalY = solSide === 'Y' ? sizeLamports : tokenTarget;

    let buyQuote: Awaited<ReturnType<typeof getJupiterBuyQuote>>;
    let buyTxB64: string;
    try {
      buyQuote = await getJupiterBuyQuote(cfg.jupiterBaseUrl, tokenMint, tokenTarget, ec.execution.slippageBps);
      buyTxB64 = await buildJupiterSwapTx(cfg.jupiterBaseUrl, buyQuote, ownerPk.toBase58());
    } catch (err) {
      // SAFE: the token leg can't be acquired (no Jupiter route / a 4xx quote — an illiquid or unroutable token).
      // We do NOT open a HALF (one-sided) position that wouldn't match the two-sided leader's composition — we SKIP
      // the open entirely. Nothing is stashed or published before this point, so it's a clean no-op (no partial
      // position, no stranded token, no dormant state).
      void journal.record({ stage: 'open', outcome: 'skipped', reason: 'twosided_unbuyable', leader: cfg.leader, pool: e.pool, leaderPosition: e.position, detail: { tokenMint, err: (err as Error).message } });
      return; // SAFE: never a partial/one-sided copy
    }
    const buyKey = `${cfg.leader}:${e.pool}:buy:${e.signature}`;
    const buyCommandId = deriveCommandId(buyKey);
    const { issuedAtSlot, deadlineSlot } = await slots();

    // Stash the open context → built+published only once the buy lands (see pendingTwoSidedOpens / build-after-buy).
    pendingTwoSidedOpens.set(buyCommandId, { e, dist, totalX, totalY, sizeSol });
    await publish({
      commandId: buyCommandId,
      eventKey: buyKey,
      kind: 'buy',
      pool: e.pool,
      positionPubkey: ownerPk.toBase58(), // n/a for a swap — Wall B binds to owner's ATA of the bought token
      owner: ownerPk.toBase58(),
      txBase64: buyTxB64,
      sizeSol: Number(buyQuote.inAmount) / 1e9, // SOL spend cap → re-clamped against maxTradeSol by the coffre
      targetBinRange: { lower: 0, upper: 0 },
      issuedAtSlot,
      deadlineSlot,
      buy: { outputMint: tokenMint, exactOutAmountRaw: tokenTarget.toString(), maxInLamports: buyQuote.inAmount },
    });
    log.info({ tokenMint, tokenTarget: tokenTarget.toString(), maxInSol: Number(buyQuote.inAmount) / 1e9, solLamports: sizeLamports.toString(), bins: dist.length }, '🪙 two-sided BUY published — the open follows once the buy lands');
  }

  /** Build + publish the two-sided OPEN once its BUY has landed (token + ATA now exist → clean SDK build). Keyed
   *  by the buy's commandId; a no-op if there's no pending open (e.g. a reshape buy, which builds its add directly). */
  async function publishTwoSidedOpenAfterBuy(buyCommandId: string): Promise<void> {
    const ctx = pendingTwoSidedOpens.get(buyCommandId);
    if (!ctx) return;
    pendingTwoSidedOpens.delete(buyCommandId);
    const { e, dist, totalX, totalY, sizeSol } = ctx;
    const poolPk = new PublicKey(e.pool);
    const pair = await createDlmmPair(conn, poolPk);
    const eventKey = `${cfg.leader}:${e.pool}:open:${e.signature}`;
    const commandId = deriveCommandId(eventKey);
    const posKp: Keypair = derivePositionKeypair(commandId);
    const built = await buildOpenByWeight(conn, poolPk, ownerPk, posKp.publicKey, totalX, totalY, dist, pair); // token held now → estimation works
    const { issuedAtSlot, deadlineSlot } = await slots();
    const lower = Math.min(...dist.map((d) => d.binId));
    const upper = Math.max(...dist.map((d) => d.binId));
    const sr: Omit<SignRequest, 'issuedAtMs'> = {
      commandId,
      eventKey,
      kind: 'open',
      pool: e.pool,
      positionPubkey: posKp.publicKey.toBase58(),
      owner: ownerPk.toBase58(),
      txBase64: serializeUnsigned(withCuLimit(built, TWO_SIDED_CU_LIMIT)),
      sizeSol,
      targetBinRange: { lower, upper },
      issuedAtSlot,
      deadlineSlot,
    };
    const mirror = registry.open({ leaderPosition: e.position, ourPosition: sr.positionPubkey, pool: e.pool, nonSolSymbol: e.nonSolSymbol, sizeSol, lowerBin: lower, upperBin: upper, openedAt: Date.now() });
    await store.saveOpen(mirror); // persist BEFORE publishing → never an untracked open
    await publish(sr, { leaderPosition: e.position, leaderSizeSol: e.depositSol });
    log.info({ our: sr.positionPubkey, bins: dist.length }, '🪙 two-sided OPEN published (after buy landed)');
  }

  async function handleClose(e: DetectedEvent): Promise<void> {
    const m = registry.get(e.position);
    if (!m) return;
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
      void journal.record({ stage: 'reshape', outcome: 'skipped', reason: 'non_sol_pool', leader: cfg.leader, pool: m.pool, leaderPosition: e.position, ourPosition: m.ourPosition });
      return;
    }
    const solSide = meta.solSide;
    const pair = await createDlmmPair(conn, poolPk);
    const leaderShape = await readLeaderPositionShape(conn, poolPk, leaderPk, e.position, pair);
    if (!leaderShape) return; // leader gone → the reconcile closes ours
    const ourShape = await readLeaderPositionShape(conn, poolPk, ownerPk, m.ourPosition, pair);
    if (!ourShape) {
      void journal.record({ stage: 'reshape', outcome: 'skipped', reason: 'not_on_chain_yet', leader: cfg.leader, pool: m.pool, leaderPosition: e.position, ourPosition: m.ourPosition });
      return;
    }

    // SHAPE-EXACT re-sync. Align by offset-from-LOWER (the open re-anchor maps leader.lower ↔ our.lower), so the
    // per-bin target = factor × leader per-bin. A SELECTIVE leader trim/add is mirrored on the exact bins (the
    // old size-only resync only matched the total → shape drifted).
    const solOf = (b: { x: bigint; y: bigint }) => lamportsToSol(solSide === 'Y' ? b.y : b.x);
    const tokenOf = (b: { x: bigint; y: bigint }) => Number(solSide === 'Y' ? b.x : b.y); // RAW token units
    const leaderBins = leaderShape.perBin.map((b) => ({ offset: b.binId - leaderShape.lowerBinId, sol: solOf(b) }));
    const ourBins = ourShape.perBin.map((b) => ({ offset: b.binId - ourShape.lowerBinId, sol: solOf(b) }));
    const leaderTokenBins = leaderShape.perBin.map((b) => ({ offset: b.binId - leaderShape.lowerBinId, sol: tokenOf(b) }));
    const ourTokenBins = ourShape.perBin.map((b) => ({ offset: b.binId - ourShape.lowerBinId, sol: tokenOf(b) }));
    // SOL-leg ops (removes are proportional → cover both legs); token-leg ADD deficit handled two-sided when enabled.
    const { ops, tokenAddOps } = planTwoSidedReshape(leaderBins, ourBins, leaderTokenBins, ourTokenBins, copyRatio, ec.sizing.maxTradeSizeSol, ec.execution.reshapeBinDeadbandSol, ec.execution.reshapeBinDeadbandToken);
    const twoSidedAdd = ec.twoSidedMode === 'on' && tokenAddOps.length > 0;
    if (ops.length === 0 && !twoSidedAdd) {
      void journal.record({ stage: 'reshape', outcome: 'noop', leader: cfg.leader, pool: m.pool, leaderPosition: e.position, ourPosition: m.ourPosition });
      return;
    }

    const calls = reshapeToCalls(ops, ourShape.lowerBinId);
    // Our position's bin range is fixed at open; can't add outside it (leader extending its range = v1 limit).
    const adds = calls.adds.filter((a) => a.binId >= ourShape.lowerBinId && a.binId <= ourShape.upperBinId);
    if (adds.length < calls.adds.length) {
      void journal.record({ stage: 'reshape', outcome: 'skipped', reason: 'partial_range', leader: cfg.leader, pool: m.pool, leaderPosition: e.position, ourPosition: m.ourPosition, detail: { dropped: calls.adds.length - adds.length } });
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
      // TWO-SIDED reshape add: deficit on the SOL leg AND the token leg → BUY the token deficit (ExactOut,
      // published first so the coffre confirms it before the add lands) then add both legs by-weight.
      const tokenMint = solSide === 'Y' ? meta.mintX : meta.mintY;
      const tokenAdds = tokenAddOps
        .map((o) => ({ binId: ourShape.lowerBinId + o.offset, raw: Math.round(o.addSol) }))
        .filter((a) => a.binId >= ourShape.lowerBinId && a.binId <= ourShape.upperBinId && a.raw > 0);
      const solShaped = adds.length > 0 ? reanchorShape(0, 0, adds.map((a) => ({ binId: a.binId, amount: BigInt(Math.round(a.addSol * 1e9)) }))) : null;
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
      const present = [...byBin.values()];
      const loBin = Math.min(...present.map((d) => d.binId));
      const hiBin = Math.max(...present.map((d) => d.binId));
      const dist: WeightBin[] = [];
      for (let b = loBin; b <= hiBin; b++) dist.push(byBin.get(b) ?? { binId: b, xBps: 0, yBps: 0 });
      const totalAddSol = adds.reduce((s, a) => s + a.addSol, 0);
      const addLamports = BigInt(Math.round(totalAddSol * 1e9));
      const totalTokenRaw = BigInt(tokenAdds.reduce((s, a) => s + a.raw, 0));
      const buyQuote = await getJupiterBuyQuote(cfg.jupiterBaseUrl, tokenMint, totalTokenRaw, ec.execution.slippageBps);
      const buyTxB64 = await buildJupiterSwapTx(cfg.jupiterBaseUrl, buyQuote, ownerPk.toBase58());
      const buyKey = `${cfg.leader}:${m.pool}:reshape-buy:${e.signature}`;
      await publish({ commandId: deriveCommandId(buyKey), eventKey: buyKey, kind: 'buy', pool: m.pool, positionPubkey: ownerPk.toBase58(), owner: ownerPk.toBase58(), txBase64: buyTxB64, sizeSol: Number(buyQuote.inAmount) / 1e9, targetBinRange: { lower: 0, upper: 0 }, issuedAtSlot, deadlineSlot, buy: { outputMint: tokenMint, exactOutAmountRaw: totalTokenRaw.toString(), maxInLamports: buyQuote.inAmount } }, { stage: 'reshape', leaderPosition: m.leaderPosition });
      const built = await buildAddByWeight(conn, poolPk, ownerPk, new PublicKey(m.ourPosition), solSide === 'X' ? addLamports : totalTokenRaw, solSide === 'Y' ? addLamports : totalTokenRaw, dist, pair);
      const lower = loBin;
      const upper = hiBin;
      const addKey = `${cfg.leader}:${m.pool}:reshape-add:${e.signature}`;
      await publish({ commandId: deriveCommandId(addKey), eventKey: addKey, kind: 'add', pool: m.pool, positionPubkey: m.ourPosition, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(withCuLimit(built, TWO_SIDED_CU_LIMIT)), sizeSol: totalAddSol, targetBinRange: { lower, upper }, issuedAtSlot, deadlineSlot });
    } else if (adds.length > 0) {
      const totalAddSol = adds.reduce((s, a) => s + a.addSol, 0);
      const shaped = reanchorShape(0, 0, adds.map((a) => ({ binId: a.binId, amount: BigInt(Math.round(a.addSol * 1e9)) }))); // delta 0: keep binIds, amounts → BPS
      const dist: WeightBin[] = shaped.weights.map((w) => ({ binId: w.binId, xBps: solSide === 'X' ? w.bps : 0, yBps: solSide === 'Y' ? w.bps : 0 }));
      const addLamports = BigInt(Math.round(totalAddSol * 1e9));
      const built = await buildAddByWeight(conn, poolPk, ownerPk, new PublicKey(m.ourPosition), solSide === 'X' ? addLamports : 0n, solSide === 'Y' ? addLamports : 0n, dist, pair);
      const eventKey = `${cfg.leader}:${m.pool}:reshape-add:${e.signature}`;
      await publish({ commandId: deriveCommandId(eventKey), eventKey, kind: 'add', pool: m.pool, positionPubkey: m.ourPosition, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(firstTx(built)), sizeSol: totalAddSol, targetBinRange: { lower: shaped.lowerBinId, upper: shaped.upperBinId }, issuedAtSlot, deadlineSlot });
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
    });

    for (const our of plan.markClosed) {
      const m = tracked.find((x) => x.ourPosition === our);
      if (!m) continue;
      await store.markClosed(m.leaderPosition);
      registry.close(m.leaderPosition);
      recentlyPublishedClose.delete(our);
      rugSlTracker.forget(our);
      void journal.record({ stage: 'close', outcome: 'confirmed', leader: cfg.leader, pool: m.pool, leaderPosition: m.leaderPosition, ourPosition: our, detail: { via: 'reconcile' } });
    }
    for (const rc of plan.reClose) {
      // Grace: skip if we published a close for this position recently (let the in-flight close land first).
      if (now - (recentlyPublishedClose.get(rc.ourPosition) ?? 0) < RECLOSE_GRACE_MS) continue;
      const m = tracked.find((x) => x.ourPosition === rc.ourPosition);
      if (m) await publishReClose(m);
    }
    for (const orphan of plan.orphans) {
      // Stray position on our wallet (a bug-forgotten mirror or a manual open) → AUTO-CLOSE it (spec 04
      // reconcile; Valhalla force-closes random DLMMs). We have its pool + bins from the enumerator. The grace
      // avoids re-publishing while a previous orphan-close is still landing.
      const p = held.find((h) => h.position === orphan);
      if (p && now - (recentlyPublishedClose.get(orphan) ?? 0) >= RECLOSE_GRACE_MS) await publishOrphanClose(p);
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
        registry.close(m.leaderPosition); // in-memory; DB markClosed by the reconcile once the close lands
        rugSlTracker.forget(m.ourPosition);
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
    await publish({ commandId: deriveCommandId(eventKey), eventKey, kind: 'close', pool: p.pool, positionPubkey: p.position, owner: ownerPk.toBase58(), txBase64: serializeUnsigned(firstTx(built)), sizeSol: 0, targetBinRange: { lower: p.lowerBinId, upper: p.upperBinId }, issuedAtSlot, deadlineSlot }, { stage: 'failsafe', severity: 'warn', reason: 'orphan' });
    recentlyPublishedClose.set(p.position, Date.now());
    await alert(log, 'orphan auto-close: untracked on-chain position force-closed', { position: p.position, pool: p.pool });
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
    void journal.record({ stage: 'close', outcome: 'confirmed', leader: cfg.leader, pool: m.pool, leaderPosition: m.leaderPosition, ourPosition, detail: { via: 'ev_executed' } });
  }

  // ev:executed feedback → fast residual sell. Once the vault confirms a CLOSE landed, the close returned SOL +
  // a residual non-SOL token; we immediately swap that residual back to SOL (Jupiter, built here → verified by
  // Wall B → signed by the vault). This is the FAST trigger — no waiting for the 30s reconcile.
  /** Build + publish a Jupiter token→SOL sell for `residualRaw` units of `tokenMint` (shared by the close-
   *  triggered residual sell and the wallet safety sweep). `source` only labels the event/log. Returns whether
   *  a sell was published (false = quote below the SOL-out floor). */
  async function publishSell(tokenMint: string, residualRaw: bigint, pool: string, source: 'close' | 'sweep'): Promise<boolean> {
    const t0 = Date.now();
    const ec = eff();
    const quote = await getJupiterQuote(cfg.jupiterBaseUrl, tokenMint, residualRaw, ec.execution.slippageBps);
    const minOut = minOutWithSlippage(BigInt(quote.outAmount), ec.execution.slippageBps);
    if (minOut < BigInt(ec.execution.minSellOutLamports)) {
      void journal.record({ stage: 'sell', outcome: 'skipped', reason: 'below_min_sell_out', leader: cfg.leader, pool, detail: { tokenMint, outAmount: quote.outAmount, source } });
      return false;
    }
    const txBase64 = await buildJupiterSwapTx(cfg.jupiterBaseUrl, quote, ownerPk.toBase58());

    const eventKey = `${cfg.leader}:${pool}:${source}:${tokenMint}:${residualRaw}`;
    const { issuedAtSlot, deadlineSlot } = await slots();
    await publish({
      commandId: deriveCommandId(eventKey),
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
    const decision = decideResidualSell(residual, BigInt(eff().execution.dustTokenRaw));
    if (!decision.sell) {
      void journal.record({ stage: 'sell', outcome: 'skipped', reason: decision.reason, leader: cfg.leader, pool: ev.pool, detail: { tokenMint } });
      return;
    }
    await publishSell(tokenMint, residual, ev.pool, 'close');
  }

  /** No-miss safety net: enumerate EVERY non-SOL token on the copier wallet (classic SPL + Token-2022) and sell
   *  each back to SOL. Catches anything the close-triggered sell missed — a brain downtime, a failed/rejected
   *  sell, or a residual from any other source — so the wallet never holds a dormant non-SOL balance. */
  async function sweepWallet(): Promise<void> {
    const balances = await readAllOwnerTokenBalances(conn, ownerPk);
    const toSweep = planWalletSweep(balances, WSOL_MINT, BigInt(eff().execution.dustTokenRaw));
    if (toSweep.length === 0) return;
    void journal.record({ stage: 'sweep', outcome: 'detected', leader: cfg.leader, detail: { count: toSweep.length, mints: toSweep.map((b) => b.mint) } });
    for (const b of toSweep) {
      await publishSell(b.mint, b.amountRaw, ownerPk.toBase58(), 'sweep').catch((e) => {
        void journal.record({ stage: 'sweep', outcome: 'failed', reason: 'build_error', leader: cfg.leader, detail: { mint: b.mint, error: (e as Error).message } });
        return alert(log, 'wallet sweep sell failed to build/publish', { error: (e as Error).message, mint: b.mint });
      });
    }
  }

  const onEvent = (e: DetectedEvent, source: EventSource): void => {
    const pos = tracker.apply(e);
    log.debug({ source, position: e.position, instr: e.instruction, depositSol: e.depositSol, posNull: !pos }, '👁️ onEvent in');
    if (source === 'replay' || !pos) return; // mono-user: no copying of a past open (stale)
    const t0 = Date.now();
    const kind = classifyInstruction(e.instruction);
    const tracked = registry.hasOpen(e.position);
    const ecRoute = eff();
    const action = classifyEventAction(e, tracked, { infiniteAdd: ecRoute.infiniteAdd, claimFloorSol: ecRoute.claimFloorSol }); // pure routing (unit-tested)
    log.info({ source, position: e.position, kind, action, depositSol: e.depositSol, withdrawSol: e.withdrawSol, claimSol: e.claimSol, eventCount: pos.eventCount, tracked }, '👁️ event routed');
    if (action !== 'ignore') {
      void journal.record({ stage: 'detect', outcome: 'detected', kind: kind ?? undefined, leader: cfg.leader, pool: e.pool, leaderPosition: e.position, signature: e.signature, leaderSizeSol: e.depositSol || e.withdrawSol || e.claimSol, detail: { action, instruction: e.instruction } });
    }
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
      act
        .then(() => {
          lastActionAt = Date.now();
          lastLatencyMs = Date.now() - t0;
          log.info({ kind, brainMs: lastLatencyMs }, '🧠 build+publish');
        })
        .catch((err) => log.error({ err: (err as Error).message }, 'mirror error'));
    }
  };

  const detector = new LeaderDetector(makeDetectionDeps({ conn, pk: leaderPk, poolReader, tokenMeta, onEvent }));
  await blockhashCache.start(); // prime + background-refresh so serializeUnsigned never pays a getLatestBlockhash RTT

  // --once: validates the pipeline by forcing ONE open on a live leader position (deterministic), then exits.
  if (once) {
    await onceValidate(conn, leaderPk, poolReader, handleOpen, bus, log);
    await Promise.all([bus.quit(), control.quit()]);
    process.exit(0);
  }

  log.info({ leader: cfg.leader, owner: cfg.ownerPubkey, redis: cfg.redisUrl }, '🧠 brain started');
  await detector.poll('replay'); // sets the cursor + tracker state (without publishing)
  log.info('replay done — switching to live');

  // No-dormant-token: at boot, sweep any non-SOL balance left on the wallet (a prior downtime, a missed/
  // rejected close-sell) back to SOL before resuming — the wallet must never sit on a dormant token.
  await sweepWallet().catch((e) => alert(log, 'boot wallet sweep failed', { error: (e as Error).message }));

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
  sub.onReconnect(() => detector.poll().catch((e) => log.error({ e: (e as Error).message }, 'catch-up poll')));
  sub.watch(cfg.leader, (sig, logs) => {
    const hasDlmm = logs.some((l) => l.includes(DLMM_PROGRAM_ID));
    log.debug({ sig, hasDlmm, nLogs: logs.length }, '📡 ws notif');
    if (hasDlmm) detector.onWsSignature(sig).catch((e) => log.error({ e: (e as Error).message }, 'ws'));
  });
  sub.start();
  const timer = setInterval(() => detector.poll().catch((e) => log.error({ e: (e as Error).message }, 'poll')), POLL_MS);
  const reconTimer = setInterval(() => reconcileSweep().catch((e) => log.error({ e: (e as Error).message }, 'reconcile')), RECON_MS);
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
  const consumeExecuted = async (): Promise<void> => {
    let backoff = 1000;
    while (!stopped) {
      try {
        const msgs = await evBus.consume(EV_EXECUTED_STREAM, 'brain', 'brain-1', 'ev:executed', cfg.hmacKey, 10, 5000);
        for (const msg of msgs) {
          const ev = msg.payload as { kind?: string; pool?: string; positionPubkey?: string; commandId?: string } | null;
          if (ev?.kind === 'close' && ev.pool) {
            if (ev.positionPubkey) await onCloseConfirmed(ev.positionPubkey); // prompt DB markClosed — no 30s wait
            await onCloseExecuted({ pool: ev.pool, positionPubkey: ev.positionPubkey }).catch((e) =>
              alert(log, 'residual sell failed to build/publish', { error: (e as Error).message, pool: ev.pool }),
            );
          } else if (ev?.kind === 'buy' && ev.commandId) {
            // a two-sided open's token BUY just landed → build+publish the open now (token + ATA present)
            await publishTwoSidedOpenAfterBuy(ev.commandId).catch((e) =>
              alert(log, 'two-sided open failed to build/publish after buy', { error: (e as Error).message, commandId: ev.commandId }),
            );
          }
          await evBus.ack(EV_EXECUTED_STREAM, 'brain', msg.id);
        }
        backoff = 1000;
      } catch (e) {
        await alert(log, 'brain ev:executed loop errored — backoff', { error: (e as Error).message });
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
      const sym = meta.mintX === 'So11111111111111111111111111111111111111112' ? meta.mintY : meta.mintX;
      logger.info({ pool: leg.lbPair, position: leg.position }, '--once: forced open on live position');
      await handleOpen({ signature: `once-${leg.position}`, blockTime: 1, instruction: 'AddLiquidityByStrategy2', depositSol: 0.5, withdrawSol: 0, claimSol: 0, pool: leg.lbPair, position: leg.position, nonSolMint: sym, nonSolSymbol: null });
      // re-read the stream to prove the publication
      const msgs = await bus.consume('copybot:cmd:sign', 'validate', 'v1', 'cmd:sign', cfg.hmacKey, 5, 2000).catch(() => []);
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
