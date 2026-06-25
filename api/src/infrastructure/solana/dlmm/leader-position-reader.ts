/**
 * Copy-bot · P3 — reading a leader's on-chain position via the Meteora SDK (I/O). Gives the EXACT liquidity
 * distribution per bin (the "shape"), which will be re-anchored (`reanchor.ts`) then replicated at the
 * by-weight add. Fills the engine gap P0.2 ("extract bin range + shape"). Loaded in CJS (cf.
 * `dlmm-tx-builder.ts`: the SDK's ESM build breaks under tsx; bundled via tsup at runtime).
 */
import DLMM from '@meteora-ag/dlmm';
import type { Connection, PublicKey } from '@solana/web3.js';

export interface LeaderBinLiquidity {
  binId: number;
  x: bigint;
  y: bigint;
}

export interface LeaderPositionShape {
  positionPubkey: string;
  /** CURRENT active bin of the pool (anchor point of our copy). */
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  perBin: LeaderBinLiquidity[];
}

/**
 * Reads the leader's positions in `pool`. Returns the requested one (`positionPubkey`) or, failing that, the
 * first one carrying liquidity; `null` if the leader has no (live) position here. Includes the current active bin.
 */
export async function readLeaderPositionShape(
  conn: Connection,
  pool: PublicKey,
  leader: PublicKey,
  positionPubkey?: string,
  pair?: DLMM, // reuse a pre-created instance (shared with the tx build) to avoid a second DLMM.create
): Promise<LeaderPositionShape | null> {
  const dlmm = pair ?? (await DLMM.create(conn, pool));
  const { activeBin, userPositions } = await dlmm.getPositionsByUserAndLbPair(leader);
  const hasLiquidity = (p: (typeof userPositions)[number]): boolean =>
    p.positionData.positionBinData.some((b) => b.positionXAmount !== '0' || b.positionYAmount !== '0');
  const chosen = positionPubkey
    ? userPositions.find((p) => p.publicKey.toBase58() === positionPubkey)
    : userPositions.find(hasLiquidity);
  if (!chosen) return null;

  const d = chosen.positionData;
  return {
    positionPubkey: chosen.publicKey.toBase58(),
    activeBinId: activeBin.binId,
    lowerBinId: d.lowerBinId,
    upperBinId: d.upperBinId,
    perBin: d.positionBinData.map((b) => ({
      binId: b.binId,
      x: BigInt(b.positionXAmount),
      y: BigInt(b.positionYAmount),
    })),
  };
}

/**
 * Enumerates ALL the DLMM position pubkeys owned by `owner` across every pool (on-chain reality). This is the
 * ground truth for the anti-dormant reconcile: it never relies on our DB/registry, only on what actually exists
 * on-chain. Heavy RPC (getProgramAccounts) → call on a periodic cadence, not on the hot path.
 */
export async function readUserPositionPubkeys(conn: Connection, owner: PublicKey): Promise<string[]> {
  const byPair = await DLMM.getAllLbPairPositionsByUser(conn, owner);
  const pubkeys: string[] = [];
  for (const info of byPair.values()) {
    for (const position of info.lbPairPositionsData) pubkeys.push(position.publicKey.toBase58());
  }
  return pubkeys;
}

/** An on-chain position our wallet holds, with the pool + bin range needed to CLOSE it (e.g. an orphan). */
export interface UserPosition {
  position: string;
  pool: string;
  lowerBinId: number;
  upperBinId: number;
}

/**
 * Like `readUserPositionPubkeys` but RICH: each position with its pool (lbPair) + bin range, so the reconcile
 * can not only DETECT a stray/untracked position but also build a close for it (orphan auto-close). Heavy RPC
 * (getProgramAccounts) → periodic cadence only, never the hot path.
 */
export async function readUserPositions(conn: Connection, owner: PublicKey): Promise<UserPosition[]> {
  const byPair = await DLMM.getAllLbPairPositionsByUser(conn, owner);
  const out: UserPosition[] = [];
  for (const [pool, info] of byPair.entries()) {
    for (const position of info.lbPairPositionsData) {
      out.push({
        position: position.publicKey.toBase58(),
        pool,
        lowerBinId: position.positionData.lowerBinId,
        upperBinId: position.positionData.upperBinId,
      });
    }
  }
  return out;
}
