/** Skip if the token moved more than the threshold recently — anti-chase / stale-entry guard (`06` §1.4). */
import { numericThresholdBrick } from '../filter';

export const maxPriceChangePercent = numericThresholdBrick({
  id: 'maxPriceChangePercent',
  scope: 'per-leader',
  speedClass: 'cached',
  source: 'jupiter-token',
  safePreset: null,
  configKey: 'maxPriceChangePercent',
  contextKey: 'priceChangePercent',
  metric: 'max_price_change',
  bound: 'max',
});
