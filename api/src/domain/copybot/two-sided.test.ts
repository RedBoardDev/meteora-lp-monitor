import { describe, expect, it } from 'vitest';
import type { BinSol } from './position-adjust';
import { type LeaderBinLegs, planTwoSided, planTwoSidedReshape, sizeTwoSided } from './two-sided';

const sumSol = (w: { solBps: number }[]): number => w.reduce((s, b) => s + b.solBps, 0);
const sumToken = (w: { tokenBps: number }[]): number => w.reduce((s, b) => s + b.tokenBps, 0);

describe('planTwoSided — replicate BOTH legs (or fall back to SOL-only)', () => {
  it('SOL-only position (token leg all zero) → twoSided=false, SOL BPS sum 10000, token BPS all 0', () => {
    const legs: LeaderBinLegs[] = [
      { binId: 100, solRaw: 100n, tokenRaw: 0n },
      { binId: 101, solRaw: 100n, tokenRaw: 0n },
      { binId: 102, solRaw: 100n, tokenRaw: 0n },
    ];
    const p = planTwoSided(legs, 102, 102, 0n); // delta 0
    expect(p.twoSided).toBe(false);
    expect(sumSol(p.weights)).toBe(10000);
    expect(sumToken(p.weights)).toBe(0);
    expect(p.leaderTokenRaw).toBe(0n);
  });

  it('token leg present but ≤ dust → twoSided=false (not worth a buy)', () => {
    const legs: LeaderBinLegs[] = [
      { binId: 100, solRaw: 100n, tokenRaw: 5n },
      { binId: 101, solRaw: 100n, tokenRaw: 3n },
    ];
    expect(planTwoSided(legs, 101, 101, 10n).twoSided).toBe(false); // 8 ≤ 10 dust
  });

  it('genuine two-sided → both legs reproduced, each summing 10000; the shared active bin carries BOTH', () => {
    // bins 99,100 hold SOL (≤ active); 100 (active) + 101,102 hold token. bin 100 = mixed (both legs).
    const legs: LeaderBinLegs[] = [
      { binId: 99, solRaw: 50n, tokenRaw: 0n },
      { binId: 100, solRaw: 50n, tokenRaw: 20n },
      { binId: 101, solRaw: 0n, tokenRaw: 40n },
      { binId: 102, solRaw: 0n, tokenRaw: 40n },
    ];
    const p = planTwoSided(legs, 100, 100, 0n);
    expect(p.twoSided).toBe(true);
    expect(sumSol(p.weights)).toBe(10000);
    expect(sumToken(p.weights)).toBe(10000);
    expect(p.leaderSolRaw).toBe(100n);
    expect(p.leaderTokenRaw).toBe(100n);
    const active = p.weights.find((w) => w.binId === 100);
    expect(active?.solBps).toBeGreaterThan(0);
    expect(active?.tokenBps).toBeGreaterThan(0); // the active bin is replicated on BOTH sides
  });

  it('fully-crossed token-only position (no SOL leg) → twoSided=true, SOL BPS all 0, token BPS sum 10000', () => {
    const legs: LeaderBinLegs[] = [
      { binId: 200, solRaw: 0n, tokenRaw: 60n },
      { binId: 201, solRaw: 0n, tokenRaw: 40n },
    ];
    const p = planTwoSided(legs, 199, 199, 0n);
    expect(p.twoSided).toBe(true);
    expect(sumSol(p.weights)).toBe(0);
    expect(sumToken(p.weights)).toBe(10000);
  });

  it('re-anchors to OUR active bin (delta shift) — bins move by ourActive − leaderActive', () => {
    const legs: LeaderBinLegs[] = [
      { binId: 100, solRaw: 50n, tokenRaw: 0n },
      { binId: 101, solRaw: 0n, tokenRaw: 50n },
    ];
    const p = planTwoSided(legs, 100, 105, 0n); // delta +5
    expect(p.weights.map((w) => w.binId).sort((a, b) => a - b)).toEqual([105, 106]);
  });

  it('empty position (no SOL, no token) → throws (must not silently produce an empty deposit)', () => {
    expect(() => planTwoSided([{ binId: 100, solRaw: 0n, tokenRaw: 0n }], 100, 100, 0n)).toThrow();
  });
});

describe('sizeTwoSided — scale BOTH legs by the leader-leg ratio (NOT total value), SOL leg capped', () => {
  it('50% → exactly half of EACH leg (composition preserved)', () => {
    expect(sizeTwoSided(120_000_000n, 5_000_000n, 50, 1_000_000_000n)).toEqual({ solLamports: 60_000_000n, tokenTarget: 2_500_000n });
  });

  it('100% → both legs at full leader size', () => {
    expect(sizeTwoSided(120_000_000n, 5_000_000n, 100, 1_000_000_000n)).toEqual({ solLamports: 120_000_000n, tokenTarget: 5_000_000n });
  });

  it('cap: SOL leg over maxSol → SOL clamped AND token scaled by the SAME factor (composition still holds)', () => {
    // 100% of 1 SOL leg, cap 0.5 SOL → factor 0.5 → token also halved.
    expect(sizeTwoSided(1_000_000_000n, 4_000_000n, 100, 500_000_000n)).toEqual({ solLamports: 500_000_000n, tokenTarget: 2_000_000n });
  });

  it('no cap (maxSol 0) → pure ratio, no clamp', () => {
    expect(sizeTwoSided(100n, 80n, 50, 0n)).toEqual({ solLamports: 50n, tokenTarget: 40n });
  });
});

describe('planTwoSidedReshape — proportional removes (both legs) + per-leg token ADD deficit', () => {
  const ratio = 0.5;
  const NO_CAP = 1_000_000;
  const DEAD = 0.001;

  it('leader GREW both legs → SOL adds AND token adds (the token leg to buy + deposit)', () => {
    const leaderSol: BinSol[] = [{ offset: 0, sol: 1.0 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0.2 }]; // target 0.5 → add 0.3
    const leaderToken: BinSol[] = [{ offset: 0, sol: 100 }]; // token "amount" (UI)
    const ourToken: BinSol[] = [{ offset: 0, sol: 20 }]; // target 50 → add 30
    const r = planTwoSidedReshape(leaderSol, ourSol, leaderToken, ourToken, ratio, NO_CAP, DEAD, 1);
    expect(r.ops.some((o) => o.action === 'add')).toBe(true);
    expect(r.tokenAddOps.length).toBe(1);
    expect(r.tokenAddOps[0]?.addSol).toBeCloseTo(30, 6); // 0.5×100 − 20
  });

  it('leader SHRANK → SOL-leg removes (proportional, cover BOTH legs) + NO token adds', () => {
    const leaderSol: BinSol[] = [{ offset: 0, sol: 0.2 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0.4 }]; // target 0.1 → remove
    const leaderToken: BinSol[] = [{ offset: 0, sol: 20 }];
    const ourToken: BinSol[] = [{ offset: 0, sol: 40 }]; // token also above target → but removes are proportional
    const r = planTwoSidedReshape(leaderSol, ourSol, leaderToken, ourToken, ratio, NO_CAP, DEAD, 1);
    expect(r.ops.some((o) => o.action === 'remove')).toBe(true);
    expect(r.tokenAddOps.length).toBe(0); // no token ADD on a shrink
  });

  it('SOL-only position (no token leg) → no token adds', () => {
    const leaderSol: BinSol[] = [{ offset: 0, sol: 1.0 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0.2 }];
    const r = planTwoSidedReshape(leaderSol, ourSol, [{ offset: 0, sol: 0 }], [{ offset: 0, sol: 0 }], ratio, NO_CAP, DEAD, 1);
    expect(r.tokenAddOps.length).toBe(0);
  });

  // FIX #119: when the SOL cap binds, BOTH legs must scale by the SAME factor (mirror the OPEN's sizeTwoSided).
  // The old code capped only the SOL leg and left the token leg at `ratio × leaderToken` → the copy bought token
  // toward an UNCAPPED target and ratcheted past maxTradeSizeSol, re-detecting a deficit every event.
  it('capped: SOL cap binds → token leg scaled by the SAME shared factor, NOT the uncapped ratio', () => {
    // ratio 1, leaderSol total 1.0, cap 0.5 → shared factor = min(1, 0.5/1.0) = 0.5.
    const leaderSol: BinSol[] = [{ offset: 0, sol: 1.0 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0 }];
    const leaderToken: BinSol[] = [{ offset: 0, sol: 100 }];
    const ourToken: BinSol[] = [{ offset: 0, sol: 0 }];
    const CAP = 0.5;
    const r = planTwoSidedReshape(leaderSol, ourSol, leaderToken, ourToken, 1, CAP, DEAD, DEAD);
    const solAdd = r.ops.find((o) => o.offset === 0 && o.action === 'add');
    expect(solAdd?.action === 'add' && solAdd.addSol).toBeCloseTo(0.5, 6); // SOL leg capped at factor × 1.0
    // Token target = factor × 100 = 50 (SAME factor). The old POSITIVE_INFINITY/ratio code targeted ratio × 100 = 100.
    expect(r.tokenAddOps[0]?.addSol).toBeCloseTo(50, 6);
  });

  it('uncapped: cap does not bind → shared factor == ratio (token leg unchanged)', () => {
    const leaderSol: BinSol[] = [{ offset: 0, sol: 1.0 }];
    const ourSol: BinSol[] = [{ offset: 0, sol: 0 }];
    const leaderToken: BinSol[] = [{ offset: 0, sol: 100 }];
    const ourToken: BinSol[] = [{ offset: 0, sol: 0 }];
    const r = planTwoSidedReshape(leaderSol, ourSol, leaderToken, ourToken, 0.5, NO_CAP, DEAD, DEAD);
    const solAdd = r.ops.find((o) => o.offset === 0 && o.action === 'add');
    expect(solAdd?.action === 'add' && solAdd.addSol).toBeCloseTo(0.5, 6); // factor == ratio 0.5
    expect(r.tokenAddOps[0]?.addSol).toBeCloseTo(50, 6); // 0.5 × 100 — identical to the capped-off path
  });

  // The fidelity bug the on-chain SHRINK test caught: a PURE-TOKEN bin (above the active bin, no SOL leg) is
  // invisible to the SOL-leg remove plan, so on a leader shrink it was never trimmed → the copy drifted
  // token-heavy. The fix emits a token-leg remove on such bins (but NOT on mixed bins already covered by a SOL
  // remove, to avoid a double trim).
  it('leader SHRANK including a PURE-TOKEN bin → that bin gets a token-leg remove, mixed bin not double-trimmed', () => {
    const leaderSol: BinSol[] = [{ offset: 0, sol: 0.2 }, { offset: 2, sol: 0 }]; // offset 2 = pure-token bin (no SOL)
    const ourSol: BinSol[] = [{ offset: 0, sol: 0.4 }, { offset: 2, sol: 0 }]; // mixed bin over target → SOL remove
    const leaderToken: BinSol[] = [{ offset: 0, sol: 20 }, { offset: 2, sol: 10 }];
    const ourToken: BinSol[] = [{ offset: 0, sol: 40 }, { offset: 2, sol: 20 }]; // both over target after the shrink
    const r = planTwoSidedReshape(leaderSol, ourSol, leaderToken, ourToken, ratio, NO_CAP, DEAD, 1);

    const removes = r.ops.filter((o) => o.action === 'remove');
    // The pure-token bin (offset 2) is now removed — WITHOUT the fix it would be missing and the copy stays token-heavy.
    const tokenBinRemove = removes.find((o) => o.offset === 2);
    expect(tokenBinRemove).toBeDefined();
    if (tokenBinRemove?.action === 'remove') expect(tokenBinRemove.bps).toBe(7500); // target 5 vs cur 20 → remove 75%
    // The mixed bin (offset 0) is trimmed by the SOL-leg remove only — exactly ONE op, no token-leg duplicate.
    expect(removes.filter((o) => o.offset === 0).length).toBe(1);
    expect(r.tokenAddOps.length).toBe(0); // a shrink has no token adds
  });
});
