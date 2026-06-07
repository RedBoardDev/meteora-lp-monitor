import { describe, expect, it } from 'vitest';
import { isOutOfRange, resolveRangeStatus } from './position';

describe('resolveRangeStatus', () => {
  it('is "in" when the price is within bounds', () => {
    expect(resolveRangeStatus(10, 5, 15)).toBe('in');
  });

  it('detects out_down (below) and out_up (above)', () => {
    expect(resolveRangeStatus(4, 5, 15)).toBe('out_down');
    expect(resolveRangeStatus(20, 5, 15)).toBe('out_up');
  });

  it('tolerates inverted min/max bounds', () => {
    expect(resolveRangeStatus(10, 15, 5)).toBe('in');
  });

  it('is "unknown" without a pool price or with non-finite bounds', () => {
    expect(resolveRangeStatus(null, 5, 15)).toBe('unknown');
    expect(resolveRangeStatus(10, Number.NaN, 15)).toBe('unknown');
  });
});

describe('isOutOfRange', () => {
  it('is true only for out_up / out_down', () => {
    expect(isOutOfRange('out_up')).toBe(true);
    expect(isOutOfRange('out_down')).toBe(true);
    expect(isOutOfRange('in')).toBe(false);
    expect(isOutOfRange('unknown')).toBe(false);
  });
});
