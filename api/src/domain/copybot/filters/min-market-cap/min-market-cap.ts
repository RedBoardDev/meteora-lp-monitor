/** Skip tokens below a market-cap threshold (`06` §1.4). Source: Jupiter v2 (`mcap`). */
import { numericThresholdBrick } from '../filter';

export const minMarketCapUsd = numericThresholdBrick({
  id: 'minMarketCapUsd',
  scope: 'per-leader',
  speedClass: 'cached',
  source: 'jupiter-token',
  safePreset: 1_000_000,
  configKey: 'minMarketCapUsd',
  contextKey: 'marketCapUsd',
  metric: 'min_market_cap',
  bound: 'min',
});
