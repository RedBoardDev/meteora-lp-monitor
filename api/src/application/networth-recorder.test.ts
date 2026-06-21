import type { WalletState } from '@binsight/shared';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { WalletFlowRepository } from '@/domain/ports';
import { NetworthRecorder, type NetworthSnapshotStore } from './networth-recorder';

function stateFor(
  scope: string,
  totals: { walletTotalSol: number; tvlSol: number; idleSol: number },
) {
  return {
    scope,
    totals: { ...totals },
    openPositions: [],
    asOfSlot: null,
    freshness: 'fresh',
    updatedAt: Date.now(),
  } as unknown as WalletState;
}

/** A bus stub that captures the 'state' handler so a test can drive it synchronously. */
function busStub() {
  let handler: ((s: WalletState) => void) | undefined;
  return {
    on: (_type: 'state', h: (s: WalletState) => void) => {
      handler = h;
      return () => {};
    },
    emit: async (s: WalletState) => {
      handler?.(s);
      // onState is async (fire-and-forget from the handler); let its microtasks settle.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function deps(reconstructedSum = 0) {
  const snapRepo: NetworthSnapshotStore & { record: ReturnType<typeof vi.fn> } = {
    record: vi.fn(async () => {}),
  };
  const flowRepo = {
    reconstructedSum: vi.fn(async () => reconstructedSum),
  } as unknown as WalletFlowRepository & { reconstructedSum: ReturnType<typeof vi.fn> };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger & {
    error: ReturnType<typeof vi.fn>;
  };
  return { snapRepo, flowRepo, logger };
}

describe('NetworthRecorder', () => {
  it('records the wallet total from the state payload', async () => {
    const { snapRepo, flowRepo, logger } = deps();
    const bus = busStub();
    new NetworthRecorder(bus, snapRepo, flowRepo, logger).start();

    await bus.emit(stateFor('walletA', { walletTotalSol: 12, tvlSol: 8, idleSol: 4 }));

    expect(snapRepo.record).toHaveBeenCalledTimes(1);
    const [wallet, p] = snapRepo.record.mock.calls[0]!;
    expect(wallet).toBe('walletA');
    expect(p).toMatchObject({ walletTotalSol: 12, tvlSol: 8, idleSol: 4 });
    expect(typeof p.ts).toBe('number');
  });

  it('throttles to one snapshot per wallet per 15-min bucket', async () => {
    const { snapRepo, flowRepo, logger } = deps();
    const bus = busStub();
    new NetworthRecorder(bus, snapRepo, flowRepo, logger).start();

    await bus.emit(stateFor('walletA', { walletTotalSol: 1, tvlSol: 1, idleSol: 0 }));
    await bus.emit(stateFor('walletA', { walletTotalSol: 2, tvlSol: 2, idleSol: 0 }));
    // a DIFFERENT wallet is not throttled by walletA's bucket.
    await bus.emit(stateFor('walletB', { walletTotalSol: 9, tvlSol: 9, idleSol: 0 }));

    expect(snapRepo.record).toHaveBeenCalledTimes(2);
    expect(snapRepo.record.mock.calls.map((c) => c[0])).toEqual(['walletA', 'walletB']);
  });

  it('ignores the aggregated "all" scope (never persisted under a non-address key)', async () => {
    const { snapRepo, flowRepo, logger } = deps();
    const bus = busStub();
    new NetworthRecorder(bus, snapRepo, flowRepo, logger).start();

    await bus.emit(stateFor('all', { walletTotalSol: 100, tvlSol: 60, idleSol: 40 }));

    expect(snapRepo.record).not.toHaveBeenCalled();
  });

  it('logs a fail-loud error when the flow ledger diverges from on-chain idle beyond tolerance', async () => {
    // ledger = 10, idle = 5 → drift 5 > 0.5 ⇒ must shout.
    const { snapRepo, flowRepo, logger } = deps(10);
    const bus = busStub();
    new NetworthRecorder(bus, snapRepo, flowRepo, logger).start();

    await bus.emit(stateFor('walletA', { walletTotalSol: 5, tvlSol: 0, idleSol: 5 }));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatchObject({
      wallet: 'walletA',
      ledger: 10,
      idleSol: 5,
      drift: 5,
    });
  });

  it('stays quiet when ledger and on-chain idle agree within tolerance (SOL-only wallet)', async () => {
    const { snapRepo, flowRepo, logger } = deps(4.9);
    const bus = busStub();
    new NetworthRecorder(bus, snapRepo, flowRepo, logger).start();

    await bus.emit(stateFor('walletA', { walletTotalSol: 5, tvlSol: 0.1, idleSol: 4.9 }));

    expect(logger.error).not.toHaveBeenCalled();
  });
});
