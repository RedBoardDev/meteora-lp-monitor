/** Skip if the token is in the user's permanent skip-list (`06` §1.4, USER-GLOBAL). Source: local. */
import { type FilterBrick, PASS, skip } from '../filter';

export const ignoredTokens: FilterBrick = {
  id: 'ignoredTokens',
  family: 'filter',
  scope: 'user-global',
  speedClass: 'instant',
  defaultEnabled: false,
  source: 'local',
  safePreset: null,
  enabled: (cfg) => cfg.ignoredTokens.length > 0,
  evaluate: (cfg, c) => (c.nonSolMint && cfg.ignoredTokens.includes(c.nonSolMint) ? skip('ignored_token') : PASS),
};
