import { type OpenPosition, SOL_MINT } from '@binsight/shared';
import { describe, expect, it } from 'vitest';
import type { OnchainPositionValue, OnchainWalletSnapshot } from './dlmm';
import { binPriceRaw } from './dlmm-pnl';
import { liveMarkWallet, livePoolPrice } from './live-mark';

const TOKEN = 'Tok1111111111111111111111111111111111111111';
const POS = 'Pos1111111111111111111111111111111111111111';
const BIN_STEP = 100; // 1% bins
const DEC_X = 6; // token X
const DEC_Y = 9; // token Y = SOL
const LOWER = -100;
const UPPER = 100;

/** UI price (token-X in token-Y) of a bin — the space minPrice/maxPrice/poolPrice live in. */
const uiPrice = (binId: number) => binPriceRaw(binId, BIN_STEP) * 10 ** (DEC_X - DEC_Y);
const MIN_PRICE = uiPrice(LOWER);
const MAX_PRICE = uiPrice(UPPER);

/** A SOL-quote (Y = SOL) snapshot holding 1.0 token-X and no token-Y, active mid-range. */
function snapshot(): OnchainWalletSnapshot {
  const pos: OnchainPositionValue = {
    positionAddress: POS,
    lbPair: 'Pool11111111111111111111111111111111111111',
    tokenXMint: TOKEN,
    tokenYMint: SOL_MINT,
    amountX: 1_000_000n, // 1.0 token at 6 dp
    amountY: 0n,
    feeX: 0n,
    feeY: 0n,
    decimalsX: DEC_X,
    decimalsY: DEC_Y,
    activeId: 0,
    binStep: BIN_STEP,
    lowerBinId: LOWER,
    upperBinId: UPPER,
    lamports: 0n,
  };
  return {
    owner: 'Owner111111111111111111111111111111111111111',
    slot: 100,
    slotSkew: 0,
    nativeLamports: 0n,
    idleTokens: [],
    positions: [pos],
    complete: true,
  };
}

/** The open row as it stood after the last EXACT read (poolPrice = mid-range = uiPrice(0)). */
function openRow(): OpenPosition {
  return {
    positionAddress: POS,
    wallet: 'Owner111111111111111111111111111111111111111',
    poolAddress: 'Pool11111111111111111111111111111111111111',
    tokenX: 'TOK',
    tokenY: 'SOL',
    tokenXMint: TOKEN,
    strategy: null,
    sizeSol: 0.001, // 1.0 token * poolPrice(1e-3)
    pnlSol: 0.0002,
    pnlPctSol: 25, // ⇒ recovered deposit basis = 0.0002 / 25 * 100 = 0.0008 SOL
    claimedFeesSol: 0,
    unclaimedFeesSol: 0,
    rangeStatus: 'in',
    minPrice: MIN_PRICE,
    maxPrice: MAX_PRICE,
    poolPrice: uiPrice(0),
    outOfRangeSince: null,
    openedAt: null,
    updatedAt: 1,
  };
}

describe('livePoolPrice', () => {
  it('Y=SOL → the token-X SOL price IS the X-in-Y price (direct)', () => {
    expect(
      livePoolPrice({ tokenXMint: TOKEN, tokenYMint: SOL_MINT }, new Map([[TOKEN, 0.005]])),
    ).toBe(0.005);
  });

  it('X=SOL → invert the token-Y SOL price to get X(=SOL)-in-Y', () => {
    expect(
      livePoolPrice({ tokenXMint: SOL_MINT, tokenYMint: TOKEN }, new Map([[TOKEN, 0.25]])),
    ).toBe(1 / 0.25);
  });

  it('non-SOL-quote pool or a missing/zero quote → null (caller keeps the cached price)', () => {
    expect(livePoolPrice({ tokenXMint: TOKEN, tokenYMint: 'Usdc' }, new Map())).toBeNull();
    expect(livePoolPrice({ tokenXMint: TOKEN, tokenYMint: SOL_MINT }, new Map())).toBeNull();
    expect(
      livePoolPrice({ tokenXMint: TOKEN, tokenYMint: SOL_MINT }, new Map([[TOKEN, 0]])),
    ).toBeNull();
  });
});

describe('liveMarkWallet — value', () => {
  it('re-prices the CACHED amount at the fresh price and flags the valuation NOT persistable', () => {
    // Price doubles (1e-3 → 2e-3 SOL/token); the held 1.0 token is re-valued: size + wallet total double.
    const { valued, open } = liveMarkWallet(snapshot(), [openRow()], new Map([[TOKEN, 0.002]]));

    expect(valued.sizeSolByPosition.get(POS)).toBeCloseTo(0.002, 12);
    expect(valued.walletTotalSol).toBeCloseTo(0.002, 12);
    // complete:false ⇒ freshness!=='fresh' ⇒ the NetworthRecorder never persists this approximate mark.
    expect(valued.complete).toBe(false);

    const row = open[0]!;
    expect(row.sizeSol).toBeCloseTo(0.002, 12);
    // uPnL tracks the +0.001 size move by the exact linear delta; pnl% rescales on the same deposit basis.
    expect(row.pnlSol).toBeCloseTo(0.0012, 12); // 0.0002 + (0.002 - 0.001)
    expect(row.pnlPctSol).toBeCloseTo(150, 9); // 0.0012 / 0.0008 * 100
  });

  it('leaves a row untouched when its position is absent from the cached snapshot', () => {
    const orphan = { ...openRow(), positionAddress: 'Other' };
    const { open } = liveMarkWallet(snapshot(), [orphan], new Map([[TOKEN, 0.002]]));
    expect(open[0]).toEqual(orphan);
  });
});

describe('liveMarkWallet — in/out-of-range from the live price vs the cached [lower,upper] bins', () => {
  const cases: { price: number; expected: OpenPosition['rangeStatus'] }[] = [
    { price: uiPrice(0), expected: 'in' }, // mid-range
    { price: MAX_PRICE * 2, expected: 'out_up' }, // price above the upper bin
    { price: MIN_PRICE / 2, expected: 'out_down' }, // price below the lower bin
  ];
  for (const { price, expected } of cases) {
    it(`price ${price} ⇒ ${expected}`, () => {
      const { open } = liveMarkWallet(snapshot(), [openRow()], new Map([[TOKEN, price]]));
      expect(open[0]!.rangeStatus).toBe(expected);
      expect(open[0]!.poolPrice).toBeCloseTo(price, 15);
    });
  }

  it('keeps the cached range when the live price is unavailable (no Jupiter quote)', () => {
    const { open } = liveMarkWallet(snapshot(), [openRow()], new Map());
    expect(open[0]!.rangeStatus).toBe('in'); // cached poolPrice (mid-range) is retained
    expect(open[0]!.poolPrice).toBe(uiPrice(0));
  });
});
