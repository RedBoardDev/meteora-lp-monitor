import type { PositionBin, PositionBins } from '@meteora/shared';
import type { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import {
  BINS_PER_ARRAY,
  binToArrayIndex,
  decodeBin,
  decodeLbPair,
  decodePosition,
  decodePositionHeader,
  deriveBinArray,
} from './layout';
import { coverageIndices } from './valuation';

const ui = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

/**
 * Per-bin liquidity distribution of one OPEN position, decoded from on-chain accounts at a single slot
 * (the data behind the Price-Bin histogram). Returns null for a closed/missing position.
 */
export async function fetchPositionBins(
  conn: Connection,
  decimalsOf: (mint: string) => Promise<number>,
  positionAddress: string,
): Promise<PositionBins | null> {
  const pk = new PublicKey(positionAddress);
  const head = await conn.getAccountInfo(pk, 'confirmed');
  if (!head) return null;
  const { lbPair, lowerBinId, upperBinId } = decodePositionHeader(head.data);
  const indices = coverageIndices(lowerBinId, upperBinId);
  const { context, value } = await conn.getMultipleAccountsInfoAndContext(
    [pk, lbPair, ...indices.map((i) => deriveBinArray(lbPair, i))],
    'confirmed',
  );
  if (!value[0] || !value[1]) return null;
  const pos = decodePosition(value[0].data);
  const lbp = decodeLbPair(value[1].data);
  const binArray = new Map<number, Uint8Array | null>();
  indices.forEach((idx, n) => {
    binArray.set(idx, value[2 + n]?.data ?? null);
  });

  const decX = await decimalsOf(lbp.tokenXMint.toBase58());
  const decY = await decimalsOf(lbp.tokenYMint.toBase58());
  const priceFactor = 1 + lbp.binStep / 10000;

  const bins: PositionBin[] = [];
  for (let b = pos.lowerBinId; b <= pos.upperBinId; b++) {
    const share = pos.shares[b - pos.lowerBinId]!;
    let amountX = 0n;
    let amountY = 0n;
    const ba = binArray.get(binToArrayIndex(b));
    if (share > 0n && ba) {
      const bin = decodeBin(ba, b - binToArrayIndex(b) * BINS_PER_ARRAY);
      if (bin.liquiditySupply > 0n) {
        amountX = (share * bin.amountX) / bin.liquiditySupply;
        amountY = (share * bin.amountY) / bin.liquiditySupply;
      }
    }
    bins.push({
      binId: b,
      price: priceFactor ** b * 10 ** (decX - decY),
      amountX: ui(amountX, decX),
      amountY: ui(amountY, decY),
    });
  }

  return {
    slot: context.slot,
    activeBinId: lbp.activeId,
    binStep: lbp.binStep,
    tokenXMint: lbp.tokenXMint.toBase58(),
    tokenYMint: lbp.tokenYMint.toBase58(),
    bins,
  };
}
