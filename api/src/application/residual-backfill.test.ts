import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import type { EnhancedTxGateway, PositionRepository } from '@/domain/ports';
import { EventBus } from './event-bus';
import { type PositionFlow, ResidualBackfill } from './residual-backfill';

const MINT_A = 'MINT_A';
const T = 1_700_000_000_000; // ms

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('ResidualBackfill — reconstructPurged (purely on-chain recovery of the purged tail)', () => {
  it('writes each position SOL leg immediately, then refines residual positions with real sold cash', async () => {
    // A has a residual it really sold (5 SOL); B is leg-only. RealizedPnlEngine cannot reach these
    // (Meteora purged them), so this rebuilds them from on-chain data alone — held remainder at 0.
    const candidates = [
      { positionAddress: 'A', closedAt: T },
      { positionAddress: 'B', closedAt: T },
    ];
    const flows: Record<string, NonNullable<PositionFlow>> = {
      A: { solLegSol: -1, residualAmount: 100, residualMint: MINT_A },
      B: { solLegSol: 2, residualAmount: 0, residualMint: MINT_A },
    };

    const repoCalls: Array<[string, number]> = [];
    const repo = {
      onchainCandidates: async () => candidates,
      setAuthoritativePnl: async (address: string, pnl: number) => {
        repoCalls.push([address, pnl]);
      },
    } as unknown as PositionRepository;

    const enhanced = {
      enabled: true,
      // A's 100-token residual was dumped for 5 SOL at close; FIFO attributes it fully to A.
      fetchSells: async () => ({
        sells: [{ ts: T / 1000, mint: MINT_A, tokenAmount: 100, solReceived: 5 }],
        complete: true,
        oldestTs: 0,
      }),
    } as unknown as EnhancedTxGateway;

    const positionFlow = async (address: string): Promise<PositionFlow> => flows[address] ?? null;

    const bus = new EventBus();
    let emitted = false;
    bus.on('closedChanged', () => {
      emitted = true;
    });

    const backfill = new ResidualBackfill(enhanced, positionFlow, repo, bus, noopLogger);
    const res = await backfill.reconstructPurged('WALLET');

    const lastFor = (addr: string) => [...repoCalls].reverse().find(([a]) => a === addr)?.[1];

    // A: SOL leg (−1) + real sold proceeds (5) + held(0) = 4 (residual refinement applied last).
    expect(lastFor('A')).toBeCloseTo(4, 9);
    // B: leg-only (no residual) → just the exact on-chain SOL leg, never refined.
    expect(lastFor('B')).toBeCloseTo(2, 9);

    expect(res.scanned).toBe(2);
    expect(res.fixed).toBe(2);
    expect(emitted).toBe(true);
  });

  it('is a no-op when there are no on-chain candidates (nothing to recover)', async () => {
    const repo = {
      onchainCandidates: async () => [],
      setAuthoritativePnl: async () => {
        throw new Error('must not write when there are no candidates');
      },
    } as unknown as PositionRepository;
    const enhanced = {
      enabled: true,
      fetchSells: async () => ({ sells: [], complete: true, oldestTs: 0 }),
    } as unknown as EnhancedTxGateway;
    const backfill = new ResidualBackfill(
      enhanced,
      async () => null,
      repo,
      new EventBus(),
      noopLogger,
    );
    expect(await backfill.reconstructPurged('WALLET')).toEqual({ scanned: 0, fixed: 0 });
  });
});
