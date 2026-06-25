/** Skip tokens below a Jupiter Organic Score threshold — the primary anti-rug signal (`06` §1.4). Jupiter v2. */
import { numericThresholdBrick } from '../filter';

export const minJupOrganicScore = numericThresholdBrick({
  id: 'minJupOrganicScore',
  scope: 'per-leader',
  speedClass: 'external-call',
  source: 'jupiter-token',
  safePreset: 50,
  configKey: 'minJupOrganicScore',
  contextKey: 'organicScore',
  metric: 'min_organic_score',
  bound: 'min',
});
