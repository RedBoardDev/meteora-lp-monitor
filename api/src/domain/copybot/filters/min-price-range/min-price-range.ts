/**
 * Skip a DLMM open whose range coverage (bins × binStep / 100) is below threshold — rejects ultra-tight
 * single-bin snipes (`06` §1.4, Valhalla "Min Bin Count"). Source: leader-shape (instant — computed from the
 * leader position we already read on-chain, no external call).
 */
import { numericThresholdBrick } from '../filter';

export const minPriceRangePercent = numericThresholdBrick({
  id: 'minPriceRangePercent',
  scope: 'per-leader',
  speedClass: 'instant',
  source: 'leader-shape',
  safePreset: 3,
  configKey: 'minPriceRangePercent',
  contextKey: 'priceRangePercent',
  metric: 'min_price_range',
  bound: 'min',
});
