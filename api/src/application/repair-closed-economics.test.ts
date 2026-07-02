import { describe, expect, it } from 'vitest';
import type { LoadedPoolMeta, PositionEconomics, StoredLeg } from '@/domain/dlmm';
import { positionEconomics } from '@/domain/dlmm-pnl';
import { repairClosedEconomicsFromLegs } from './repair-closed-economics';

const WALLET = 'w';
const SOL = 1_000_000_000; // lamports per SOL

// A SOL-Y pool at binStep 10 (factor 1.001); activeBinId 0 → price 1, so a SOL-Y leg values at its Y amount.
const solPool: LoadedPoolMeta = { binStep: 10, solSide: 'Y', mintX: 'MEME', mintY: 'So1' };

const leg = (over: Partial<StoredLeg> & Pick<StoredLeg, 'kind'>): StoredLeg => ({
  signature: 'sig',
  position: 'P',
  lbPair: 'POOL',
  activeBinId: 0,
  amountX: 0n,
  amountY: 0n,
  blockTime: 1,
  ...over,
});

/** Minimal fakes exposing only the two methods the recompute uses (the Pick seams). */
function fakes(opts: {
  stored: Map<string, PositionEconomics>;
  legs: StoredLeg[];
  pools: Map<string, LoadedPoolMeta>;
}) {
  const writes: Map<string, PositionEconomics>[] = [];
  const legRepo = {
    legsByWallet: async () => opts.legs,
    getPoolMetas: async (p: string[]) =>
      new Map([...opts.pools].filter(([k]) => p.includes(k))),
  };
  const positionRepo = {
    closedEconomicsForWallet: async () => opts.stored,
    repairClosedEconomicsMany: async (byPos: Map<string, PositionEconomics>) => {
      writes.push(new Map(byPos));
      // Emulate the DB: persisted rows now hold exactly the recomputed values (for idempotency checks).
      for (const [addr, e] of byPos) opts.stored.set(addr, e);
    },
  };
  return { legRepo, positionRepo, writes };
}

describe('repairClosedEconomicsFromLegs', () => {
  it('recomputes a stale deposit_sol=0 closed row to exactly positionEconomics(legs)', async () => {
    const legs = [
      leg({ kind: 'deposit', amountY: BigInt(3 * SOL) }),
      leg({ kind: 'withdraw', amountY: BigInt(2 * SOL) }),
      leg({ kind: 'claim', amountY: BigInt(0.5 * SOL) }),
    ];
    const expected = positionEconomics(legs, { binStep: solPool.binStep, solSide: 'Y' });
    // Stale row: deposit dropped to 0 and pnl wrong (the pre-fix bug this backfill corrects).
    const stored = new Map<string, PositionEconomics>([
      ['P', { depositSol: 0, withdrawSol: 0, claimedFeesSol: 0, pnlSol: 2.5 }],
    ]);
    const { legRepo, positionRepo, writes } = fakes({
      stored,
      legs,
      pools: new Map([['POOL', solPool]]),
    });

    const r = await repairClosedEconomicsFromLegs(WALLET, { legRepo, positionRepo });

    expect(r).toMatchObject({ scanned: 1, corrected: 1, skippedNoPoolMeta: 0, skippedNonSol: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.get('P')).toEqual(expected);
    expect(expected.depositSol).toBeCloseTo(3);
    expect(expected.pnlSol).toBeCloseTo(2 + 0.5 - 3); // withdraw + fees − deposit = −0.5
  });

  it('is idempotent: a correct row is not rewritten, and a second pass corrects nothing', async () => {
    const legs = [
      leg({ kind: 'deposit', amountY: BigInt(3 * SOL) }),
      leg({ kind: 'withdraw', amountY: BigInt(4 * SOL) }),
    ];
    const good = positionEconomics(legs, { binStep: solPool.binStep, solSide: 'Y' });
    const stored = new Map<string, PositionEconomics>([['P', { ...good }]]);
    const { legRepo, positionRepo, writes } = fakes({
      stored,
      legs,
      pools: new Map([['POOL', solPool]]),
    });

    const first = await repairClosedEconomicsFromLegs(WALLET, { legRepo, positionRepo });
    expect(first.corrected).toBe(0); // already exact → no write
    expect(writes).toHaveLength(1); // called with an empty map
    expect(writes[0]!.size).toBe(0);

    const second = await repairClosedEconomicsFromLegs(WALLET, { legRepo, positionRepo });
    expect(second.corrected).toBe(0);
  });

  it('skips a closed position whose pool meta is absent (never guesses)', async () => {
    const legs = [leg({ kind: 'deposit', amountY: BigInt(SOL) })];
    const stored = new Map<string, PositionEconomics>([
      ['P', { depositSol: 0, withdrawSol: 0, claimedFeesSol: 0, pnlSol: 0 }],
    ]);
    const { legRepo, positionRepo, writes } = fakes({ stored, legs, pools: new Map() });

    const r = await repairClosedEconomicsFromLegs(WALLET, { legRepo, positionRepo });

    expect(r).toMatchObject({ scanned: 1, corrected: 0, skippedNoPoolMeta: 1 });
    expect(writes[0]!.size).toBe(0);
  });

  it('skips a non-SOL-quote pool (its SOL economics are legitimately 0)', async () => {
    const legs = [leg({ kind: 'deposit', amountX: BigInt(SOL) })];
    const stored = new Map<string, PositionEconomics>([
      ['P', { depositSol: 0, withdrawSol: 0, claimedFeesSol: 0, pnlSol: 0 }],
    ]);
    const nonSol: LoadedPoolMeta = { binStep: 10, solSide: null, mintX: 'AAA', mintY: 'BBB' };
    const { legRepo, positionRepo, writes } = fakes({
      stored,
      legs,
      pools: new Map([['POOL', nonSol]]),
    });

    const r = await repairClosedEconomicsFromLegs(WALLET, { legRepo, positionRepo });

    expect(r).toMatchObject({ scanned: 1, corrected: 0, skippedNonSol: 1 });
    expect(writes[0]!.size).toBe(0);
  });

  it('counts a closed position with no ingested legs as skippedNoLegs (nothing to recompute)', async () => {
    const stored = new Map<string, PositionEconomics>([
      ['P', { depositSol: 5, withdrawSol: 0, claimedFeesSol: 0, pnlSol: -5 }],
    ]);
    const { legRepo, positionRepo } = fakes({ stored, legs: [], pools: new Map() });

    const r = await repairClosedEconomicsFromLegs(WALLET, { legRepo, positionRepo });

    expect(r).toMatchObject({ scanned: 1, corrected: 0, skippedNoLegs: 1 });
  });

  it('does nothing for a wallet with no closed positions', async () => {
    const { legRepo, positionRepo, writes } = fakes({
      stored: new Map(),
      legs: [],
      pools: new Map(),
    });
    const r = await repairClosedEconomicsFromLegs(WALLET, { legRepo, positionRepo });
    expect(r.scanned).toBe(0);
    expect(writes).toHaveLength(0); // early return, writer not even called
  });
});
