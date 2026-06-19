import type { ClosedPosition } from '@binsight/shared';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import type { EnhancedTxGateway, PositionRepository, PositionsGateway } from '@/domain/ports';
import { EventBus } from './event-bus';
import { type PositionFlow, ResidualBackfill } from './residual-backfill';

const MINT_A = 'MINT_A';
const MINT_B = 'MINT_B';
// closedAt is in ms; T_OLD < oldestFetchedMs (1.5e12) <= T_NEW — so the older close falls BEFORE the
// oldest sell we fetched (incomplete history) and the newer one after it.
const T_OLD = 1_000_000_000_000;
const T_NEW = 2_000_000_000_000;
const OLDEST_TS_SEC = 1_500_000_000; // → oldestFetchedMs = 1.5e12, between T_OLD and T_NEW

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

/** A closed position that is BOTH a residual position and a Meteora deposit-underreport bug. */
function bugPosition(address: string, mint: string, closedAt: number): ClosedPosition {
  return {
    positionAddress: address,
    poolAddress: 'pool',
    pnlSol: 0,
    depositSol: 0, // < 0.01 …
    withdrawSol: 1, // … and > 0.1 → triggers the on-chain SOL-leg recompute (step 5)
    residualMarkSol: 2,
    residualAmount: 100,
    residualMint: mint,
    closedAt,
  } as unknown as ClosedPosition;
}

describe('ResidualBackfill — step 5 incomplete-history guard', () => {
  it('books the SOL leg ALONE for an old deposit-bug position under incomplete history, but adds trusted residual cash for a newer one', async () => {
    const pOld = bugPosition('P_OLD', MINT_A, T_OLD);
    const pNew = bugPosition('P_NEW', MINT_B, T_NEW);

    const gateway = {
      listClosedPools: async () => ['pool'],
      fetchClosedPositions: async () => [pOld, pNew],
    } as unknown as PositionsGateway;

    // Each residual's real sell lands at its close, so the FIFO ledger attributes 5 SOL to P_OLD and
    // 7 SOL to P_NEW — but the fetch reports complete:false with oldest sell at OLDEST_TS_SEC.
    const enhanced = {
      enabled: true,
      fetchSells: async () => ({
        sells: [
          { ts: T_OLD / 1000, mint: MINT_A, tokenAmount: 100, solReceived: 5 },
          { ts: T_NEW / 1000, mint: MINT_B, tokenAmount: 100, solReceived: 7 },
        ],
        complete: false,
        oldestTs: OLDEST_TS_SEC,
      }),
    } as unknown as EnhancedTxGateway;

    const flows: Record<string, NonNullable<PositionFlow>> = {
      P_OLD: { solLegSol: -1.5, residualAmount: 0, residualMint: MINT_A },
      P_NEW: { solLegSol: -2, residualAmount: 0, residualMint: MINT_B },
    };
    const positionFlow = async (address: string): Promise<PositionFlow> => flows[address] ?? null;

    const calls: Array<[string, number]> = [];
    const repo = {
      setAuthoritativePnl: async (address: string, pnl: number) => {
        calls.push([address, pnl]);
      },
    } as unknown as PositionRepository;

    const bus = new EventBus();
    let emitted = false;
    bus.on('closedChanged', () => {
      emitted = true;
    });

    const backfill = new ResidualBackfill(gateway, enhanced, positionFlow, repo, bus, noopLogger);
    const res = await backfill.run('WALLET', 30);

    const lastFor = (addr: string) => [...calls].reverse().find(([a]) => a === addr)?.[1];

    // P_OLD is older than the oldest fetched sell → its FIFO proceeds (5) are partial/untrustworthy,
    // so step 5 books the exact SOL leg ALONE. (Pre-fix this was -1.5 + 5 = 3.5 — the bug.)
    expect(lastFor('P_OLD')).toBe(-1.5);
    // P_NEW is newer than the oldest fetched sell → residual cash is trustworthy: SOL leg + 7.
    expect(lastFor('P_NEW')).toBe(5);

    expect(res.scanned).toBe(2);
    expect(emitted).toBe(true);
  });
});
