import { describe, expect, it } from 'vitest';
import type { WalletTxFlow } from '@/domain/cashflow';
import { buildCashflowCurve } from './wallet-cashflow';

const at = (date: string, h = 0) =>
  Math.floor(new Date(`${date}T${String(h).padStart(2, '0')}:00:00Z`).getTime() / 1000);

describe('buildCashflowCurve', () => {
  it('sums trading flow per day and runs a cumulative curve, filling empty days', () => {
    const flows: WalletTxFlow[] = [
      { timestamp: at('2026-06-01'), type: 'INITIALIZE_POSITION', solFlow: -10, isTrading: true },
      { timestamp: at('2026-06-03'), type: 'SWAP', solFlow: 5, isTrading: true }, // dumped a rug for 5
    ];
    const { days, totalTradingSol } = buildCashflowCurve(flows);
    expect(days.map((d) => d.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']); // gap filled
    expect(days[0]!.cumulativeSol).toBe(-10); // deployed 10
    expect(days[1]!.cumulativeSol).toBe(-10); // flat (no activity)
    expect(days[2]!.cumulativeSol).toBe(-5); // rug realized: −10 + 5 = −5
    // No external flow here → reconstructed cash balance tracks the trading curve exactly.
    expect(days.map((d) => d.cumulativeTotalSol)).toEqual([-10, -10, -5]);
    expect(totalTradingSol).toBeCloseTo(-5, 9);
  });

  it('keeps external transfers OUT of the trading curve', () => {
    const flows: WalletTxFlow[] = [
      { timestamp: at('2026-06-01'), type: 'SWAP', solFlow: 3, isTrading: true },
      { timestamp: at('2026-06-01', 2), type: 'TRANSFER', solFlow: -20, isTrading: false }, // sent to CEX
    ];
    const { days, totalTradingSol, totalExternalSol } = buildCashflowCurve(flows);
    expect(totalTradingSol).toBe(3); // PnL unaffected by the CEX withdrawal
    expect(totalExternalSol).toBe(-20);
    expect(days[0]!.cumulativeSol).toBe(3);
    // Net worth curve DOES include the external move: reconstructed cash balance = 3 + (−20) = −17.
    expect(days[0]!.cumulativeTotalSol).toBe(-17);
  });

  it('the cumulative end equals the total trading flow (lamport-consistent)', () => {
    const flows: WalletTxFlow[] = [
      { timestamp: at('2026-06-01'), type: 'SWAP', solFlow: 1.5, isTrading: true },
      { timestamp: at('2026-06-02'), type: 'SWAP', solFlow: -0.4, isTrading: true },
      { timestamp: at('2026-06-04'), type: 'SWAP', solFlow: 2.1, isTrading: true },
    ];
    const { days, totalTradingSol } = buildCashflowCurve(flows);
    expect(days[days.length - 1]!.cumulativeSol).toBeCloseTo(totalTradingSol, 9);
    // All-trading window → reconstructed cash balance equals the trading curve at every point.
    for (const d of days) expect(d.cumulativeTotalSol).toBeCloseTo(d.cumulativeSol, 9);
    expect(totalTradingSol).toBeCloseTo(3.2, 9);
  });
});
