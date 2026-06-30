/**
 * Copy-bot · P3 — DLMM tx-building adapter via the official `@meteora-ag/dlmm` SDK (I/O).
 * Produces UNSIGNED transactions (faithful open by-weight / close / claim); signing/landing = vault zone
 * (P4). The re-anchored shape (pure) lives in `domain/copybot/reanchor.ts` (tested).
 *
 * STATIC imports: this module ONLY runs built (tsup `tsup.copybot.config.ts`, CJS) — the bundle resolves the
 * ESM/CJS interop of the SDK + anchor. NEVER import it from a path launched by tsx/vitest (it would break).
 */
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import type { Connection, PublicKey, Transaction } from '@solana/web3.js';

// STATIC imports: these modules ONLY run built (tsup/esbuild) — the bundle resolves the ESM/CJS interop
// of the SDK + anchor. Do not import them from a path launched by tsx (it would break).

const toBN = (v: bigint) => new BN(v.toString());

/** A live DLMM SDK instance (pool state + bin arrays). Reused across read+build to avoid a second `DLMM.create`. */
export type DlmmPair = DLMM;

/** Create ONE DLMM instance for a pool. `DLMM.create` fetches the pool state (the bulk of the latency), so the
 *  caller should create it once and pass it to both the position read and the tx build (halves the round-trips). */
export async function createDlmmPair(conn: Connection, pool: PublicKey): Promise<DlmmPair> {
  return DLMM.create(conn, pool);
}

/** The pool's current active bin — anchor point of the opening plan. */
export async function getActiveBinId(conn: Connection, pool: PublicKey): Promise<number> {
  const dlmm = await DLMM.create(conn, pool);
  return (await dlmm.getActiveBin()).binId;
}

/** A bin of the re-anchored distribution: share of the total in BPS, per side (cf. `reanchor.ts`). */
export interface WeightBin {
  binId: number;
  xBps: number;
  yBps: number;
}

/**
 * Builds the FAITHFUL OPEN tx: create position + add liquidity **by-weight**, replicating the leader's
 * re-anchored distribution (`xYAmountDistribution`). `totalX/YLamports` = our sized amount per side
 * (SOL one-sided v1: everything on the SOL side, 0 on the other). Unsigned; may return several txs (wide
 * range → SDK chunking).
 */
export async function buildOpenByWeight(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  positionPubKey: PublicKey,
  totalXLamports: bigint,
  totalYLamports: bigint,
  distribution: WeightBin[],
  pair?: DlmmPair, // reuse a pre-created instance to skip a second DLMM.create (latency)
): Promise<Transaction | Transaction[]> {
  const dlmm = pair ?? (await DLMM.create(conn, pool));
  return dlmm.initializePositionAndAddLiquidityByWeight({
    positionPubKey,
    user: owner,
    totalXAmount: toBN(totalXLamports),
    totalYAmount: toBN(totalYLamports),
    xYAmountDistribution: distribution.map((d) => ({
      binId: d.binId,
      xAmountBpsOfTotal: new BN(d.xBps),
      yAmountBpsOfTotal: new BN(d.yBps),
    })),
  });
}

/** Adds liquidity BY-WEIGHT to an EXISTING position (the leader added → we add our proportional share on the
 *  leader's CURRENT re-anchored shape). Unsigned. */
export async function buildAddByWeight(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  positionPubKey: PublicKey,
  totalXLamports: bigint,
  totalYLamports: bigint,
  distribution: WeightBin[],
  pair?: DlmmPair,
): Promise<Transaction | Transaction[]> {
  const dlmm = pair ?? (await DLMM.create(conn, pool));
  // NB: both methods splice the distribution internally → pass a FRESH mapped array (never a shared ref).
  const params = {
    positionPubKey,
    user: owner,
    totalXAmount: toBN(totalXLamports),
    totalYAmount: toBN(totalYLamports),
    xYAmountDistribution: distribution.map((d) => ({
      binId: d.binId,
      xAmountBpsOfTotal: new BN(d.xBps),
      yAmountBpsOfTotal: new BN(d.yBps),
    })),
  };
  // Token-2022 leg → the v2 ix `addLiquidityByWeight2` (routes the token program from the mint's real owner + carries
  // transfer-hook accounts), the ONLY by-weight deposit that works for Token-2022. Classic SPL → keep the proven v1
  // `addLiquidityByWeight` UNCHANGED — CRITICALLY, v1 uses `addLiquidityOneSide` for a one-sided deposit (deposits SOL
  // into the valid bins regardless of the active-bin side), whereas v2 is two-sided-only and deposits 0 for a one-sided
  // leg whose range is on the "wrong" side of the active bin. v1 is classic-pinned on-chain so it can't do Token-2022.
  return isToken2022Pool(dlmm) ? dlmm.addLiquidityByWeight2(params) : dlmm.addLiquidityByWeight(params);
}


/** Token-2022 program id — a pool whose token leg is owned by this needs the v2 (interface) deposit ix, not v1. */
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** A DLMM pool is "Token-2022" when EITHER leg's mint is owned by the Token-2022 program (DLMM.create resolves the
 *  real owner). Such pools REJECT the v1 by-weight deposit on-chain (token_x_program is pinned to classic) → the open
 *  must use the 2-tx create + addLiquidityByWeight2 path; classic-SPL pools keep the atomic 1-tx by-weight open. */
export function isToken2022Pool(pair: DlmmPair): boolean {
  return pair.tokenX.owner.toBase58() === TOKEN_2022_PROGRAM_ID || pair.tokenY.owner.toBase58() === TOKEN_2022_PROGRAM_ID;
}

/** SDK DEFAULT_BIN_PER_POSITION: `createEmptyPosition` covers a span of ≤ this many bins; a wider span needs the
 *  extended-position path. */
const MAX_BINS_SINGLE_EMPTY_POSITION = 70;

/**
 * Builds the empty-position creation tx (TX1 of a Token-2022 open): `initializePosition` (+ bin arrays) only, which
 * is token-program-agnostic so it works on a Token-2022 pool. The deposit (TX2 = `buildAddByWeight` →
 * addLiquidityByWeight2) follows once this CONFIRMS on-chain. Signers: [owner, positionKeypair]. Unsigned.
 */
export async function buildCreateEmptyPosition(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  positionPubKey: PublicKey,
  minBinId: number,
  maxBinId: number,
  pair?: DlmmPair,
): Promise<Transaction> {
  const dlmm = pair ?? (await DLMM.create(conn, pool));
  if (maxBinId - minBinId + 1 > MAX_BINS_SINGLE_EMPTY_POSITION) {
    return dlmm.createExtendedEmptyPosition(minBinId, maxBinId, positionPubKey, owner);
  }
  return dlmm.createEmptyPosition({ positionPubKey, minBinId, maxBinId, user: owner });
}

/** Removes a FRACTION (`bps`) of OUR position WITHOUT closing it — mirrors a leader's partial trim. Unsigned. */
export async function buildRemovePartial(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  position: PublicKey,
  fromBinId: number,
  toBinId: number,
  bps: number,
  pair?: DlmmPair,
): Promise<Transaction[]> {
  const dlmm = pair ?? (await DLMM.create(conn, pool));
  return dlmm.removeLiquidity({ user: owner, position, fromBinId, toBinId, bps: new BN(bps), shouldClaimAndClose: false });
}

/** One-sided SOL open with a chosen shape (Spot / BidAsk / Curve) — for the leader-test wallet (the driving
 *  tool). The leader defines the shape; the bot copies it EXACTLY (by-weight) by reading the resulting position.
 *  Used to prove the copy is shape-agnostic across all DLMM strategies. */
export async function buildOpenByStrategy(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  positionPubKey: PublicKey,
  solSide: 'X' | 'Y',
  solLamports: bigint,
  widthBins: number,
  strategyType: StrategyType = StrategyType.Spot,
): Promise<Transaction | Transaction[]> {
  const dlmm = await DLMM.create(conn, pool);
  const active = (await dlmm.getActiveBin()).binId;
  const [minBinId, maxBinId] = solSide === 'Y' ? [active - widthBins, active] : [active, active + widthBins];
  return dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey,
    user: owner,
    totalXAmount: toBN(solSide === 'X' ? solLamports : 0n),
    totalYAmount: toBN(solSide === 'Y' ? solLamports : 0n),
    strategy: { minBinId, maxBinId, strategyType, singleSidedX: solSide === 'X' },
  });
}

/**
 * Open a TWO-SIDED position by strategy (both SOL AND token deposited, range spanning both sides of the active
 * bin). Test tool: lets leader-control create a genuine two-sided leader position to copy. The caller must hold
 * `tokenRaw` of the non-SOL token already (bought beforehand).
 */
export async function buildOpenByStrategyTwoSided(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  positionPubKey: PublicKey,
  solSide: 'X' | 'Y',
  solLamports: bigint,
  tokenRaw: bigint,
  widthBins: number,
  strategyType: StrategyType = StrategyType.Spot,
  pair?: DlmmPair,
): Promise<Transaction | Transaction[]> {
  const dlmm = pair ?? (await DLMM.create(conn, pool));
  const active = (await dlmm.getActiveBin()).binId;
  return dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey,
    user: owner,
    totalXAmount: toBN(solSide === 'X' ? solLamports : tokenRaw),
    totalYAmount: toBN(solSide === 'Y' ? solLamports : tokenRaw),
    strategy: { minBinId: active - widthBins, maxBinId: active + widthBins, strategyType }, // two-sided: no singleSidedX
  });
}

/** Adds one-sided SOL to an EXISTING position with a chosen shape (leader-test driver: simulate a leader add). */
export async function buildAddByStrategy(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  positionPubKey: PublicKey,
  solSide: 'X' | 'Y',
  solLamports: bigint,
  widthBins: number,
  strategyType: StrategyType = StrategyType.Spot,
): Promise<Transaction | Transaction[]> {
  const dlmm = await DLMM.create(conn, pool);
  const active = (await dlmm.getActiveBin()).binId;
  const [minBinId, maxBinId] = solSide === 'Y' ? [active - widthBins, active] : [active, active + widthBins];
  return dlmm.addLiquidityByStrategy({
    positionPubKey,
    user: owner,
    totalXAmount: toBN(solSide === 'X' ? solLamports : 0n),
    totalYAmount: toBN(solSide === 'Y' ? solLamports : 0n),
    strategy: { minBinId, maxBinId, strategyType, singleSidedX: solSide === 'X' },
  });
}

/**
 * Add TWO-SIDED liquidity (both SOL AND token) to an EXISTING position, within its fixed [minBinId,maxBinId]
 * range. Test tool: lets leader-control GROW a two-sided leader position (the caller must already hold `tokenRaw`).
 */
export async function buildAddByStrategyTwoSided(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  positionPubKey: PublicKey,
  solSide: 'X' | 'Y',
  solLamports: bigint,
  tokenRaw: bigint,
  minBinId: number,
  maxBinId: number,
  strategyType: StrategyType = StrategyType.Spot,
  pair?: DlmmPair,
): Promise<Transaction | Transaction[]> {
  const dlmm = pair ?? (await DLMM.create(conn, pool));
  return dlmm.addLiquidityByStrategy({
    positionPubKey,
    user: owner,
    totalXAmount: toBN(solSide === 'X' ? solLamports : tokenRaw),
    totalYAmount: toBN(solSide === 'Y' ? solLamports : tokenRaw),
    strategy: { minBinId, maxBinId, strategyType }, // two-sided: no singleSidedX
  });
}

/** Map a CLI shape name to the SDK StrategyType (for the leader-control driving tool). */
export function strategyTypeFromName(name: string): StrategyType {
  if (name === 'bidask') return StrategyType.BidAsk;
  if (name === 'curve') return StrategyType.Curve;
  return StrategyType.Spot;
}

/** Builds the CLOSE tx(s): remove 100% + claim fees + close position. Unsigned. An EMPTY position (no liquidity —
 *  e.g. a leader emptied it via a remove-to-zero, or a create whose deposit never landed) makes `removeLiquidity`
 *  THROW (it reads bins that don't exist), which would otherwise crash the reconcile and leave the position dormant.
 *  Fall back to `closePositionIfEmpty` so the no-miss-close pillar holds for empties too. `closePositionIfEmpty` only
 *  closes a genuinely-empty position on-chain, so the broad catch can never discard a funded position's liquidity. */
export async function buildCloseTx(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  position: PublicKey,
  fromBinId: number,
  toBinId: number,
): Promise<Transaction[]> {
  const dlmm = await DLMM.create(conn, pool);
  try {
    return await dlmm.removeLiquidity({
      user: owner,
      position,
      fromBinId,
      toBinId,
      bps: new BN(10_000), // 100%
      shouldClaimAndClose: true,
    });
  } catch (removeErr) {
    // EMPTY position → removeLiquidity errored. Close it directly (reclaim rent) via closePositionIfEmpty, which
    // needs the SDK position object — fetch it. If the position isn't found/closable, surface the original error.
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner);
    const p = userPositions.find((x) => x.publicKey.toBase58() === position.toBase58());
    if (!p) throw removeErr;
    return [await dlmm.closePositionIfEmpty({ owner, position: p })];
  }
}

/** Builds the CLAIM FEES tx(s) (mid-life, without closing) on OUR position. First fetches the owner's
 *  position object (the SDK `claimSwapFee` wants the full `LbPosition`). Unsigned. */
export async function buildClaimTx(
  conn: Connection,
  pool: PublicKey,
  owner: PublicKey,
  positionPubkey: string,
): Promise<Transaction[]> {
  const dlmm = await DLMM.create(conn, pool);
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner);
  const position = userPositions.find((p) => p.publicKey.toBase58() === positionPubkey);
  if (!position) throw new Error(`claim: position ${positionPubkey} not found for ${owner.toBase58()}`);
  return dlmm.claimSwapFee({ owner, position });
}
