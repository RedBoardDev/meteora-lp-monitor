import { describe, expect, it } from 'vitest';
import { coverageIndices } from './valuation';

describe('coverageIndices (bin-array coverage, floor toward -inf)', () => {
  it('handles a single negative-bin array', () => {
    // -464..-426 both floor to -7 (×70 = -490..-421)
    expect(coverageIndices(-464, -426)).toEqual([-7]);
  });

  it('spans the zero boundary correctly', () => {
    expect(coverageIndices(-90, 5)).toEqual([-2, -1, 0]);
  });

  it('covers a wide positive range across several arrays', () => {
    expect(coverageIndices(0, 210)).toEqual([0, 1, 2, 3]); // 210 → index 3
  });
});
