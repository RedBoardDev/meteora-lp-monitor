/** Skip tokens younger than the threshold (rug/snipe avoidance, `06` §1.4). Source: Jupiter v2 (`firstPool`). */
import { numericThresholdBrick } from '../filter';

export const minTokenAgeHours = numericThresholdBrick({
  id: 'minTokenAgeHours',
  scope: 'per-leader',
  speedClass: 'cached',
  source: 'jupiter-token',
  safePreset: 2,
  configKey: 'minTokenAgeHours',
  contextKey: 'tokenAgeHours',
  metric: 'min_token_age',
  bound: 'min',
});
