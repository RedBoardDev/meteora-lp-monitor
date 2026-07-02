/** Skip if the token moved more than the threshold recently — anti-chase / stale-entry guard (`06` §1.4). */
import { compareMax, type FilterBrick, PASS } from '../filter';

const METRIC = 'max_price_change';
const CONFIG_KEY = 'maxPriceChangePercent';
const CONTEXT_KEY = 'priceChangePercent';

/**
 * Custom brick (not `numericThresholdBrick`): it compares the ABSOLUTE 24h price change against the
 * threshold, so a big DUMP (e.g. −80%) is rejected just like a big PUMP. `priceChangePercent` is a SIGNED
 * percent in the snapshot source; taking `Math.abs` here (and NOT in the shared source) keeps other filters'
 * signed semantics intact.
 */
export const maxPriceChangePercent: FilterBrick = {
  id: CONFIG_KEY,
  family: 'filter',
  scope: 'per-leader',
  speedClass: 'cached',
  defaultEnabled: false,
  source: 'jupiter-token',
  safePreset: null,
  enabled: (cfg) => cfg[CONFIG_KEY] != null,
  evaluate: (cfg, _candidate, ctx) => {
    const threshold = cfg[CONFIG_KEY];
    if (threshold == null) return PASS;
    const change = ctx[CONTEXT_KEY];
    // abs → a large move in EITHER direction (pump or dump) exceeds `max` and skips the open.
    const absChange = change === undefined ? undefined : Math.abs(change);
    return compareMax(absChange, threshold, METRIC);
  },
};
