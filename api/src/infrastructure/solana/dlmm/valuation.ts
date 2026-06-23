import {
  BINS_PER_ARRAY,
  binToArrayIndex,
  type DecodedPosition,
  decodeBin,
  wrapU128,
} from './layout';

/** Raw (base-unit) token amounts + unclaimed fees held by a position. */
export interface PositionAmounts {
  amountX: bigint;
  amountY: bigint;
  feeX: bigint;
  feeY: bigint;
  /** false when a share>0 bin's bin-array was null/absent, so its amounts were skipped (under-counted). */
  complete: boolean;
}

/**
 * Compute a position's current token amounts + unclaimed fees from on-chain accounts.
 * `binArrayByIndex` maps a bin-array index → its raw account bytes (null/absent if not fetched).
 * Pro-rata constant-sum: amount = share * bin.amount / liquiditySupply (floor). Pending fees are
 * always claimable (even at share==0); the accumulator-delta term applies only while share>0.
 * Validated byte-exact vs the datapi (0 lamport) on 13+ positions incl. the extended >70-bin path.
 */
export function valuePosition(
  pos: DecodedPosition,
  binArrayByIndex: Map<number, Uint8Array | null | undefined>,
): PositionAmounts {
  let amountX = 0n;
  let amountY = 0n;
  let feeX = 0n;
  let feeY = 0n;
  let complete = true;
  for (let b = pos.lowerBinId; b <= pos.upperBinId; b++) {
    const j = b - pos.lowerBinId;
    const share = pos.shares[j]!;
    const fi = pos.feeInfos[j]!;
    let nfx = 0n;
    let nfy = 0n;
    if (share > 0n) {
      const arrIdx = binToArrayIndex(b);
      const ba = binArrayByIndex.get(arrIdx);
      if (ba) {
        const bin = decodeBin(ba, b - arrIdx * BINS_PER_ARRAY);
        if (bin.liquiditySupply > 0n) {
          amountX += (share * bin.amountX) / bin.liquiditySupply;
          amountY += (share * bin.amountY) / bin.liquiditySupply;
        }
        const sShift = share >> 64n;
        nfx = (sShift * wrapU128(bin.feeXPerTokenStored - fi.completeX)) >> 64n;
        nfy = (sShift * wrapU128(bin.feeYPerTokenStored - fi.completeY)) >> 64n;
      } else {
        // A share is held in this bin but its bin-array account wasn't fetched (null/absent), so its
        // token amounts are silently dropped → the position value is under-counted. Flag incomplete so
        // the snapshot is treated as not-fresh and never persisted as a real Net Worth point.
        complete = false;
      }
    }
    feeX += nfx + fi.pendingX;
    feeY += nfy + fi.pendingY;
  }
  return { amountX, amountY, feeX, feeY, complete };
}

/** Distinct bin-array indices covering [lowerBinId, upperBinId]. */
export function coverageIndices(lowerBinId: number, upperBinId: number): number[] {
  const out: number[] = [];
  for (let i = binToArrayIndex(lowerBinId); i <= binToArrayIndex(upperBinId); i++) out.push(i);
  return out;
}
