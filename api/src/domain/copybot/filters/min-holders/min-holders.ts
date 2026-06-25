/** Skip tokens below a holder-count threshold — concentration proxy (`06` §1.4). Source: Jupiter v2 (free). */
import { numericThresholdBrick } from '../filter';

export const minHolders = numericThresholdBrick({
  id: 'minHolders',
  scope: 'per-leader',
  speedClass: 'external-call',
  source: 'jupiter-token',
  safePreset: null,
  configKey: 'minHolders',
  contextKey: 'holders',
  metric: 'min_holders',
  bound: 'min',
});
