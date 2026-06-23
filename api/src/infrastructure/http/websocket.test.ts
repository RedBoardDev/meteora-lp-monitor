import { describe, expect, it } from 'vitest';
import type { AccountRepository } from '@/domain/ports';
import { liveToken, sessionStillValid } from './websocket';

/** Minimal AccountRepository stub exposing only what sessionStillValid reads. */
function accounts(opts: {
  user: { tokenVersion: number } | null;
  validJtis?: Set<string>;
}): Pick<AccountRepository, 'findById' | 'isSessionValid'> {
  return {
    findById: async () => (opts.user ? ({ tokenVersion: opts.user.tokenVersion } as never) : null),
    isSessionValid: async (jti: string) => opts.validJtis?.has(jti) ?? false,
  } as Pick<AccountRepository, 'findById' | 'isSessionValid'>;
}

describe('liveToken — /live auth: native Authorization header vs browser ws-ticket (S10)', () => {
  it('prefers the Authorization: Bearer header (native — keeps the long-lived JWT out of the URL)', () => {
    expect(liveToken('Bearer abc.def.ghi', 'ticket')).toBe('abc.def.ghi');
  });

  it('falls back to the ?token= query when there is no Bearer header (browser ws-ticket)', () => {
    expect(liveToken(undefined, 'ticket')).toBe('ticket');
    expect(liveToken('Basic xyz', 'ticket')).toBe('ticket'); // non-Bearer scheme → use the ticket
  });

  it('is undefined when neither a Bearer header nor a query token is present', () => {
    expect(liveToken(undefined, undefined)).toBeUndefined();
    expect(liveToken('Bearer   ', undefined)).toBeUndefined(); // empty bearer → not a token
  });
});

describe('sessionStillValid — live-socket revocation check (mirrors the Bearer hook /live bypasses)', () => {
  it('true only when account exists, version matches, and the jti is still allow-listed', async () => {
    const a = accounts({ user: { tokenVersion: 3 }, validJtis: new Set(['J']) });
    expect(await sessionStillValid(a, 'U', 3, 'J')).toBe(true);
  });

  it('false when the account no longer exists (deleted / access revoked) — S12', async () => {
    expect(await sessionStillValid(accounts({ user: null }), 'U', 3, 'J')).toBe(false);
  });

  it('false when the token version is stale (a password reset bumped it) — S02 reset', async () => {
    const a = accounts({ user: { tokenVersion: 4 }, validJtis: new Set(['J']) });
    expect(await sessionStillValid(a, 'U', 3, 'J')).toBe(false);
  });

  it('false when the jti was revoked (logout deleted the session) — S01/S02 logout', async () => {
    const a = accounts({ user: { tokenVersion: 3 }, validJtis: new Set() });
    expect(await sessionStillValid(a, 'U', 3, 'J')).toBe(false);
  });
});
