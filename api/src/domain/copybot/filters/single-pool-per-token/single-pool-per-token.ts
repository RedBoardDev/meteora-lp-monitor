/** Skip if we ALREADY hold an open position on this token (≤1 live position per token, `06` §1.4). Local. */
import { type FilterBrick, PASS, skip } from '../filter';

export const singlePoolPerToken: FilterBrick = {
  id: 'singlePoolPerToken',
  family: 'filter',
  scope: 'per-leader',
  speedClass: 'instant',
  defaultEnabled: false,
  source: 'local',
  safePreset: true,
  enabled: (cfg) => cfg.singlePoolPerToken,
  evaluate: (_cfg, c, ctx) => (c.nonSolMint && ctx.openTokenMints.has(c.nonSolMint) ? skip('single_pool_per_token') : PASS),
};
