/** Skip tokens below a 24h trade-volume threshold (`06` §1.4, Valhalla "Min Token Trade Volume"). Jupiter v2. */
import { numericThresholdBrick } from '../filter';

export const min24hVolumeUsd = numericThresholdBrick({
  id: 'min24hVolumeUsd',
  scope: 'per-leader',
  speedClass: 'cached',
  source: 'jupiter-token',
  safePreset: null,
  configKey: 'min24hVolumeUsd',
  contextKey: 'volume24hUsd',
  metric: 'min_24h_volume',
  bound: 'min',
});
