import { describe, expect, it } from 'vitest';
import { classifyTradingByType } from './cashflow';

describe('classifyTradingByType', () => {
  it('counts SWAP and any DLMM-touching tx as trading', () => {
    expect(classifyTradingByType('SWAP', false)).toBe(true);
    expect(classifyTradingByType('TRANSFER', true)).toBe(true); // LP withdrawal shows as TRANSFER
    expect(classifyTradingByType('CLOSE_ACCOUNT', true)).toBe(true);
  });
  it('excludes a bare TRANSFER that does not touch DLMM (external / CEX move)', () => {
    expect(classifyTradingByType('TRANSFER', false)).toBe(false);
  });
});
