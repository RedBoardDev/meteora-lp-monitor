import { describe, expect, it } from 'vitest';
import { groupTokenBalancesByMint, sumTokenAmounts } from './token-balance-reader';

describe('sumTokenAmounts — residual balance summation', () => {
  it('no accounts → 0n', () => {
    expect(sumTokenAmounts([])).toBe(0n);
  });

  it('sums multiple token accounts of the same mint', () => {
    expect(sumTokenAmounts(['1000', '250', '7'])).toBe(1257n);
  });

  it('ignores missing/empty entries (a token account may have no parsed amount)', () => {
    expect(sumTokenAmounts(['100', undefined, '', '5'])).toBe(105n);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER (bigint-exact)', () => {
    expect(sumTokenAmounts(['9007199254740993', '9007199254740993'])).toBe(18014398509481986n);
  });
});

describe('groupTokenBalancesByMint — wallet sweep enumeration', () => {
  it('groups and sums multiple accounts of the same mint into one bigint balance', () => {
    expect(groupTokenBalancesByMint([{ mint: 'A', amount: '100' }, { mint: 'A', amount: '50' }])).toEqual([{ mint: 'A', amountRaw: 150n }]);
  });

  it('keeps distinct mints separate (e.g. a classic SPL leg and a Token-2022 leg)', () => {
    expect(groupTokenBalancesByMint([{ mint: 'A', amount: '10' }, { mint: 'B', amount: '20' }])).toEqual([
      { mint: 'A', amountRaw: 10n },
      { mint: 'B', amountRaw: 20n },
    ]);
  });

  it('drops zero-balance accounts (a closed/empty ATA must not be reported as a holding)', () => {
    expect(groupTokenBalancesByMint([{ mint: 'A', amount: '0' }, { mint: 'B', amount: '5' }])).toEqual([{ mint: 'B', amountRaw: 5n }]);
  });

  it('ignores entries missing a mint or amount', () => {
    expect(groupTokenBalancesByMint([{ mint: undefined, amount: '5' }, { mint: 'A', amount: undefined }, { mint: 'A', amount: '7' }])).toEqual([{ mint: 'A', amountRaw: 7n }]);
  });
});
