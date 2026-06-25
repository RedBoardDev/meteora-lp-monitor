import { describe, expect, it } from 'vitest';
import { FILTERS_ALL_OFF } from '../filter';
import { ignoredTokens } from './ignored-tokens';

const c = (mint: string | null) => ({ nonSolMint: mint, pool: 'POOL' });
const ctx = { openTokenMints: new Set<string>() };

describe('ignoredTokens — user skip-list (USER-GLOBAL, instant, local)', () => {
  it('off when the list is empty, on once the user adds a token', () => {
    expect(ignoredTokens.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(ignoredTokens.enabled({ ...FILTERS_ALL_OFF, ignoredTokens: ['MINT'] })).toBe(true);
  });
  it('mint in the list → skip ignored_token', () => {
    expect(ignoredTokens.evaluate({ ...FILTERS_ALL_OFF, ignoredTokens: ['MINT'] }, c('MINT'), ctx)).toEqual({ action: 'skip', reason: 'ignored_token' });
  });
  it('mint not in the list → pass', () => {
    expect(ignoredTokens.evaluate({ ...FILTERS_ALL_OFF, ignoredTokens: ['OTHER'] }, c('MINT'), ctx)).toEqual({ action: 'pass' });
  });
  it('null mint → pass (nothing to filter)', () => {
    expect(ignoredTokens.evaluate({ ...FILTERS_ALL_OFF, ignoredTokens: ['MINT'] }, c(null), ctx)).toEqual({ action: 'pass' });
  });
  it('meta: user-global / local / instant', () => {
    expect([ignoredTokens.scope, ignoredTokens.source, ignoredTokens.speedClass]).toEqual(['user-global', 'local', 'instant']);
  });
});
