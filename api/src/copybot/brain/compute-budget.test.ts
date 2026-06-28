import { ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { computeUnitPriceMicroLamports } from '@/domain/copybot/priority-fee';
import { applyPriorityFee, COMPUTE_BUDGET_PROGRAM, withCuLimit } from './compute-budget';

const CB_SET_UNIT_LIMIT = 2;
const CB_SET_UNIT_PRICE = 3;
const txWithLimit = (units: number): Transaction => new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
const find = (tx: Transaction, disc: number) => tx.instructions.find((ix) => ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === disc);
const priceOf = (tx: Transaction): bigint | null => {
  const ix = find(tx, CB_SET_UNIT_PRICE);
  return ix ? ix.data.readBigUInt64LE(1) : null;
};

describe('compute-budget · withCuLimit', () => {
  it('sets the CU limit and replaces any existing one (exactly one limit ix)', () => {
    const tx = txWithLimit(200_000);
    withCuLimit(tx, 1_400_000);
    const limits = tx.instructions.filter((ix) => ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === CB_SET_UNIT_LIMIT);
    expect(limits).toHaveLength(1);
    expect(limits[0]!.data.readUInt32LE(1)).toBe(1_400_000);
  });
});

describe('compute-budget · applyPriorityFee', () => {
  it('adds a CU-price ix at the tier price when the cap is not binding', () => {
    const tx = txWithLimit(200_000);
    applyPriorityFee(tx, { tier: 'medium', maxCapSol: 0.005 });
    expect(priceOf(tx)).toBe(BigInt(computeUnitPriceMicroLamports('medium', 200_000, 0.005)));
  });

  it('respects the cap: price × cuLimit never exceeds maxCapSol (the cap wins on-tx too)', () => {
    // WHY: the on-tx price must honor the same hard cap the pure function computes — a tiny cap clamps the high tier.
    const tx = txWithLimit(1_400_000);
    applyPriorityFee(tx, { tier: 'high', maxCapSol: 0.00005 });
    const price = priceOf(tx)!;
    expect(Number((price * 1_400_000n) / 1_000_000n)).toBeLessThanOrEqual(0.00005 * 1_000_000_000 + 1);
  });

  it('is idempotent — re-applying replaces, never stacks, the price ix', () => {
    const tx = txWithLimit(200_000);
    applyPriorityFee(tx, { tier: 'low', maxCapSol: 0.005 });
    applyPriorityFee(tx, { tier: 'high', maxCapSol: 0.005 });
    const prices = tx.instructions.filter((ix) => ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === CB_SET_UNIT_PRICE);
    expect(prices).toHaveLength(1);
    expect(priceOf(tx)).toBe(BigInt(computeUnitPriceMicroLamports('high', 200_000, 0.005))); // the latest tier wins
  });

  it('falls back to the default CU limit for capping when the tx carries no limit ix', () => {
    const tx = new Transaction(); // no ComputeBudget limit ix
    applyPriorityFee(tx, { tier: 'medium', maxCapSol: 0.005 });
    expect(priceOf(tx)).toBe(BigInt(computeUnitPriceMicroLamports('medium', 200_000, 0.005)));
  });

  it('returns the priority lamports it will cost (price × cuLimit / 1e6) — the figure that sizes the Jito tip', () => {
    // WHY: the brain feeds this return into jitoTipFor so priority + tip stay within the SAME cap; a wrong figure
    // would let the tip overspend the cap (or starve it). Must equal the on-tx price × the limit it priced against.
    const tx = txWithLimit(200_000);
    const spent = applyPriorityFee(tx, { tier: 'medium', maxCapSol: 0.005 });
    const micro = computeUnitPriceMicroLamports('medium', 200_000, 0.005);
    expect(spent).toBe(Math.floor((micro * 200_000) / 1_000_000));
  });

  it('the returned spend never exceeds the cap lamports (so the tip headroom is real)', () => {
    const cap = 0.00005;
    const spent = applyPriorityFee(txWithLimit(1_400_000), { tier: 'high', maxCapSol: cap });
    expect(spent).toBeLessThanOrEqual(Math.ceil(cap * 1_000_000_000));
  });
});
