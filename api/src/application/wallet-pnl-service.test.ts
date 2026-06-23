import { describe, expect, it, vi } from 'vitest';
import type { WalletTxFlow } from '@/domain/cashflow';
import type { DailyFlow, FlowCursor } from '@/domain/dlmm';
import type { WalletFlowRepository } from '@/domain/ports';
import { buildCashflowCurve, buildCashflowCurveFromDaily } from './wallet-cashflow';
import { WalletPnlService } from './wallet-pnl-service';

const dayTs = (d: number) => Math.floor(Date.UTC(2026, 5, d, 12) / 1000);
const tx = (t: number, solFlow: number, isTrading: boolean): WalletTxFlow => ({
  timestamp: t,
  type: isTrading ? 'SWAP' : 'TRANSFER',
  solFlow,
  isTrading,
});

describe('buildCashflowCurveFromDaily', () => {
  it('produces the SAME continuous curve as the per-tx builder (gap-fill + cumulative)', () => {
    const flows: WalletTxFlow[] = [
      tx(dayTs(1), 5, true),
      tx(dayTs(1), 1, true),
      tx(dayTs(2), 10, false), // external
      tx(dayTs(3), -2, true),
    ];
    const fromFlows = buildCashflowCurve(flows);
    const fromDaily = buildCashflowCurveFromDaily([
      { date: '2026-06-01', trading: 6, external: 0 },
      { date: '2026-06-02', trading: 0, external: 10 },
      { date: '2026-06-03', trading: -2, external: 0 },
    ]);
    expect(fromDaily).toEqual(fromFlows);
    // sanity on the curve itself: day 2 is gap-filled flat (cum stays 6), final cum = 4.
    expect(fromDaily.days.map((d) => d.cumulativeSol)).toEqual([6, 6, 4]);
    expect(fromDaily.totalTradingSol).toBe(4);
    expect(fromDaily.totalExternalSol).toBe(10);
  });
});

function stubRepo(daily: DailyFlow[], cursors: Record<string, FlowCursor | null>) {
  return {
    dailyFlows: vi.fn(async () => daily),
    allCursorsComplete: vi.fn(async (ws: string[]) =>
      ws.every((w) => cursors[w]?.complete === true),
    ),
  } as unknown as WalletFlowRepository & {
    dailyFlows: ReturnType<typeof vi.fn>;
    allCursorsComplete: ReturnType<typeof vi.fn>;
  };
}

const complete = (): FlowCursor => ({ oldestSig: 'g', newestSig: 'n', complete: true });

describe('WalletPnlService.curve', () => {
  it('aggregates ALL passed wallets and queries them together (wallet=all is a real SUM)', async () => {
    const repo = stubRepo([{ date: '2026-06-01', trading: 7, external: 0 }], {
      w1: complete(),
      w2: complete(),
    });
    const now = () => Date.UTC(2026, 5, 10, 12);
    const res = await new WalletPnlService(repo, now).curve(['w1', 'w2'], 30);

    expect(repo.dailyFlows).toHaveBeenCalledTimes(1);
    const [wallets, sinceSec] = repo.dailyFlows.mock.calls[0]!;
    expect(wallets).toEqual(['w1', 'w2']);
    expect(sinceSec).toBe(Math.floor((now() - 30 * 86_400_000) / 1000));
    expect(res.totalTradingSol).toBe(7);
    expect(res.complete).toBe(true);
  });

  it('complete=false while any wallet is still backfilling (cursor missing or not complete)', async () => {
    const stillBackfilling = stubRepo([], { w1: complete(), w2: null });
    expect((await new WalletPnlService(stillBackfilling).curve(['w1', 'w2'], 30)).complete).toBe(
      false,
    );

    const partial = stubRepo([], { w1: { oldestSig: 'g', newestSig: 'n', complete: false } });
    expect((await new WalletPnlService(partial).curve(['w1'], 30)).complete).toBe(false);
  });

  it('returns an empty, complete curve for an empty wallet set', async () => {
    const repo = stubRepo([], {});
    const res = await new WalletPnlService(repo).curve([], 30);
    expect(res).toEqual({ days: [], totalTradingSol: 0, totalExternalSol: 0, complete: true });
    expect(repo.dailyFlows).not.toHaveBeenCalled();
  });
});
