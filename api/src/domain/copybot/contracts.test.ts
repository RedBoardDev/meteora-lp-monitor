import { describe, expect, it } from 'vitest';
import { SignRequestSchema } from './contracts';

const valid = {
  commandId: 'cmd1',
  eventKey: 'leader:pool:open:42:sig',
  kind: 'open' as const,
  pool: 'POOL',
  positionPubkey: 'POS',
  owner: 'OWNER',
  txBase64: 'AAAA',
  sizeSol: 0.5,
  targetBinRange: { lower: -45, upper: -42 },
  issuedAtSlot: 100,
  deadlineSlot: 110,
  issuedAtMs: 1_700_000_000_000,
};

describe('SignRequestSchema', () => {
  it('parses a valid SignRequest', () => {
    expect(SignRequestSchema.parse(valid)).toMatchObject({ kind: 'open', commandId: 'cmd1' });
  });

  it('rejects an unexpected field (.strict, anti-injection)', () => {
    expect(SignRequestSchema.safeParse({ ...valid, evil: 1 }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    const { deadlineSlot, ...missing } = valid;
    expect(SignRequestSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects an unknown kind (outside open/close/claim/sell/add/remove)', () => {
    expect(SignRequestSchema.safeParse({ ...valid, kind: 'frobnicate' }).success).toBe(false);
  });

  it('accepts add/remove kinds (proportional adjustments, no sell payload)', () => {
    expect(SignRequestSchema.safeParse({ ...valid, kind: 'add' }).success).toBe(true);
    expect(SignRequestSchema.safeParse({ ...valid, kind: 'remove' }).success).toBe(true);
  });

  it('rejects a negative size', () => {
    expect(SignRequestSchema.safeParse({ ...valid, sizeSol: -1 }).success).toBe(false);
  });

  const sellPayload = { inputMint: 'MINT', inputAmountRaw: '1000', minOutLamports: '990' };

  it('rejects a sell payload on a non-sell kind (sell only allowed for kind=sell)', () => {
    expect(SignRequestSchema.safeParse({ ...valid, sell: sellPayload }).success).toBe(false);
  });

  it('rejects kind=sell WITHOUT a sell payload (no half-formed sell intent)', () => {
    expect(SignRequestSchema.safeParse({ ...valid, kind: 'sell' }).success).toBe(false);
  });

  it('parses a valid sell (kind=sell + sell payload)', () => {
    expect(SignRequestSchema.safeParse({ ...valid, kind: 'sell', sell: sellPayload }).success).toBe(true);
  });
});
