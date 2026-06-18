import type { ClosedPosition } from '@meteora/shared';
import { describe, expect, it } from 'vitest';
import {
  flowFromHistory,
  type ResidualSell,
  realizedPnl,
  reconstructRealized,
} from './residual-realized';

const SOL = 'So11111111111111111111111111111111111111112';

describe('flowFromHistory — exact SOL leg + net residual from decoded DLMM events', () => {
  it('computes the ORE case: deposit 2.475 SOL, withdraw 0.786 + fees, residual = net token X', () => {
    const hist = {
      tokenXMint: 'oreMint',
      tokenYMint: SOL,
      events: [
        { kind: 'open', amountX: 0, amountY: 0 },
        { kind: 'deposit', amountX: 0, amountY: 2.475 },
        { kind: 'claim', amountX: 0.214, amountY: 0.07 },
        { kind: 'withdraw', amountX: 7.078, amountY: 0.786 },
        { kind: 'close', amountX: 0, amountY: 0 },
      ],
    };
    const f = flowFromHistory(hist);
    expect(f.solLegSol).toBeCloseTo(0.786 + 0.07 - 2.475, 6); // −1.619
    expect(f.residualAmount).toBeCloseTo(7.292, 6);
    expect(f.residualMint).toBe('oreMint');
  });

  it('handles SOL on the X side (residual is the Y token)', () => {
    const hist = {
      tokenXMint: SOL,
      tokenYMint: 'tokMint',
      events: [
        { kind: 'deposit', amountX: 5, amountY: 0 },
        { kind: 'withdraw', amountX: 3, amountY: 1000 },
      ],
    };
    const f = flowFromHistory(hist);
    expect(f.solLegSol).toBeCloseTo(-2, 6); // 3 − 5 SOL
    expect(f.residualAmount).toBe(1000);
    expect(f.residualMint).toBe('tokMint');
  });
});

const pos = (over: Partial<ClosedPosition>): ClosedPosition =>
  ({
    positionAddress: 'p',
    pnlSol: 0,
    residualMint: 'TOK',
    residualAmount: 1000,
    residualMarkSol: 10,
    closedAt: 1_000_000,
    ...over,
  }) as unknown as ClosedPosition;

const sell = (over: Partial<ResidualSell>): ResidualSell =>
  ({ ts: 1000, mint: 'TOK', tokenAmount: 1000, solReceived: 9, ...over }) as ResidualSell;

describe('reconstructRealized — FIFO residual lot accounting', () => {
  it('attributes a single clean dump to the position (the real proceeds, not pool-spot)', () => {
    const p = pos({ closedAt: 1_000_000 }); // close at t=1000s
    const r = reconstructRealized([p], [sell({ ts: 1007, tokenAmount: 1000, solReceived: 9 })])[0]!;
    expect(r.soldAmount).toBe(1000);
    expect(r.soldProceeds).toBe(9); // real cash 9 — below the pool-spot mark of 10
    expect(r.fillFraction).toBe(1);
    expect(r.heldAmount).toBe(0);
  });

  it('sums multiple clips of the same residual into one blended proceeds', () => {
    const p = pos({ residualAmount: 1000, closedAt: 1_000_000 });
    const sells = [
      sell({ ts: 1005, tokenAmount: 600, solReceived: 6 }),
      sell({ ts: 1200, tokenAmount: 400, solReceived: 3.6 }),
    ];
    const r = reconstructRealized([p], sells)[0]!;
    expect(r.soldAmount).toBe(1000);
    expect(r.soldProceeds).toBeCloseTo(9.6, 9);
    expect(r.fillFraction).toBe(1);
  });

  it('splits one shared dump across two same-token positions by FIFO close order (no double-count)', () => {
    // Two TOK positions close, then ONE swap dumps 1500 TOK for 13.5 SOL.
    const a = pos({ positionAddress: 'A', residualAmount: 1000, closedAt: 1_000_000 });
    const b = pos({ positionAddress: 'B', residualAmount: 500, closedAt: 1_000_500 });
    const sells = [sell({ ts: 1_010, tokenAmount: 1500, solReceived: 13.5 })]; // 0.009 SOL/TOK
    const res = reconstructRealized([a, b], sells);
    const ra = res.find((x) => x.positionAddress === 'A')!;
    const rb = res.find((x) => x.positionAddress === 'B')!;
    expect(ra.soldAmount).toBe(1000);
    expect(ra.soldProceeds).toBeCloseTo(9, 9); // 1000 × 0.009
    expect(rb.soldAmount).toBe(500);
    expect(rb.soldProceeds).toBeCloseTo(4.5, 9); // remaining 500 × 0.009 — not the same tokens twice
  });

  it('marks an un-sold residual as fully held (no realized proceeds)', () => {
    const p = pos({ residualAmount: 1000, closedAt: 1_000_000 });
    const r = reconstructRealized([p], [])[0]!; // never sold
    expect(r.soldProceeds).toBe(0);
    expect(r.heldAmount).toBe(1000);
    expect(r.fillFraction).toBe(0);
  });

  it('ignores sells before the close (a prior position’s dump is not this residual)', () => {
    const p = pos({ residualAmount: 1000, closedAt: 1_000_000 });
    const r = reconstructRealized([p], [sell({ ts: 900, tokenAmount: 1000, solReceived: 9 })])[0]!;
    expect(r.soldAmount).toBe(0);
    expect(r.heldAmount).toBe(1000);
  });

  it('ignores sells far past the close window (a later, separate decision)', () => {
    const p = pos({ residualAmount: 1000, closedAt: 1_000_000 });
    const late = sell({ ts: 1000 + 4 * 86_400, tokenAmount: 1000, solReceived: 9 }); // > 3-day window
    const r = reconstructRealized([p], [late])[0]!;
    expect(r.soldAmount).toBe(0);
  });

  it('matches a dump within the 3-day window (the real exit often lands hours/days after close)', () => {
    const p = pos({ residualAmount: 1000, closedAt: 1_000_000 });
    const dump = sell({ ts: 1000 + 2 * 3600, tokenAmount: 1000, solReceived: 9 }); // 2h after close
    const r = reconstructRealized([p], [dump])[0]!;
    expect(r.soldAmount).toBe(1000);
    expect(r.soldProceeds).toBe(9);
  });

  it('splits a PARTIAL fill into sold proceeds + held remainder with no overlap', () => {
    const p = pos({ residualAmount: 1000, closedAt: 1_000_000 });
    // only 600 of the 1000-token residual is sold in-window, for 5.4 SOL
    const r = reconstructRealized(
      [p],
      [sell({ ts: 1010, tokenAmount: 600, solReceived: 5.4 })],
    )[0]!;
    expect(r.soldAmount).toBe(600);
    expect(r.soldProceeds).toBeCloseTo(5.4, 9);
    expect(r.heldAmount).toBe(400);
    expect(r.fillFraction).toBeCloseTo(0.6, 9);
    expect(r.soldAmount + r.heldAmount).toBe(1000); // reconstruct the whole, no double-count
  });
});

describe('realizedPnl', () => {
  it('swaps the pool-spot mark for sold proceeds + held current value', () => {
    const p = pos({ pnlSol: 0.5, residualMarkSol: 10 }); // pnl includes residual @ pool-spot 10
    const r = {
      positionAddress: 'p',
      soldProceeds: 8.3,
      soldAmount: 1000,
      heldAmount: 0,
      mint: 'TOK',
      fillFraction: 1,
    };
    // real residual was 8.3 (not 10) → PnL drops by 1.7
    expect(realizedPnl(p, r, 0)).toBeCloseTo(0.5 - 10 + 8.3, 9);
  });

  it('adds the current market value of a held remainder', () => {
    const p = pos({ pnlSol: 0.5, residualMarkSol: 10 });
    const r = {
      positionAddress: 'p',
      soldProceeds: 0,
      soldAmount: 0,
      heldAmount: 1000,
      mint: 'TOK',
      fillFraction: 0,
    };
    expect(realizedPnl(p, r, 7.5)).toBeCloseTo(0.5 - 10 + 7.5, 9); // held valued now at 7.5
  });
});
