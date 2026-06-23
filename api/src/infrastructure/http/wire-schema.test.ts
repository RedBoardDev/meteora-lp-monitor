import { ClientMessageSchema, WalletSchema } from '@binsight/shared';
import { describe, expect, it } from 'vitest';

const VALID = 'So11111111111111111111111111111111111111112'; // 43-char base58 (wSOL mint)

describe('wire schemas — base58 address validation (S16)', () => {
  it('WalletSchema accepts a base58 address', () => {
    expect(WalletSchema.safeParse({ address: VALID, createdAt: 1 }).success).toBe(true);
  });

  it('WalletSchema rejects non-base58 chars (0, O, punctuation)', () => {
    for (const bad of ['0'.repeat(40), `${VALID.slice(0, 42)}O`, `${VALID.slice(0, 42)}!`]) {
      expect(WalletSchema.safeParse({ address: bad, createdAt: 1 }).success).toBe(false);
    }
  });

  it('subscribe scope accepts "all" and a base58 address but rejects arbitrary text', () => {
    const ok = (scope: string) =>
      ClientMessageSchema.safeParse({ type: 'subscribe', scope }).success;
    expect(ok('all')).toBe(true);
    expect(ok(VALID)).toBe(true);
    expect(ok('../etc')).toBe(false);
    expect(ok('all; DROP')).toBe(false);
  });
});
