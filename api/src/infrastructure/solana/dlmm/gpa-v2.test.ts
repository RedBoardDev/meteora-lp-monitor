import type { GetProgramAccountsFilter } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { buildGpaV2Params, GPA_V2_PAGE_LIMIT, parseGpaV2Response } from './gpa-v2';

const PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const filters: GetProgramAccountsFilter[] = [{ memcmp: { offset: 40, bytes: 'owner' } }];

describe('buildGpaV2Params', () => {
  it('builds the [programId, config] params with the SAME filters + a pubkeys-only dataSlice', () => {
    // WHY: the V2 swap must keep discovery semantics byte-identical to the legacy getProgramAccounts —
    // same memcmp filters, base64 encoding, and a {0,0} dataSlice (pubkeys only → cheap).
    const [programId, config] = buildGpaV2Params(PROGRAM, {
      filters,
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed',
      limit: GPA_V2_PAGE_LIMIT,
    }) as [string, Record<string, unknown>];

    expect(programId).toBe(PROGRAM);
    expect(config.filters).toBe(filters);
    expect(config.encoding).toBe('base64');
    expect(config.dataSlice).toEqual({ offset: 0, length: 0 });
    expect(config.commitment).toBe('confirmed');
    expect(config.limit).toBe(GPA_V2_PAGE_LIMIT);
    // Omitted (not null) on the first page + when no incremental slot is requested.
    expect('paginationKey' in config).toBe(false);
    expect('changedSinceSlot' in config).toBe(false);
  });

  it('includes paginationKey + changedSinceSlot only when provided', () => {
    const [, config] = buildGpaV2Params(PROGRAM, {
      filters,
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed',
      limit: 100,
      paginationKey: 'cursor-2',
      changedSinceSlot: 12345,
    }) as [string, Record<string, unknown>];
    expect(config.paginationKey).toBe('cursor-2');
    expect(config.changedSinceSlot).toBe(12345);
  });
});

describe('parseGpaV2Response', () => {
  it('extracts the account pubkeys + the next cursor', () => {
    const page = parseGpaV2Response({
      result: {
        accounts: [{ pubkey: 'Pos1' }, { pubkey: 'Pos2' }],
        paginationKey: 'next',
      },
    });
    expect(page.pubkeys).toEqual(['Pos1', 'Pos2']);
    expect(page.paginationKey).toBe('next');
  });

  it('maps an absent/empty paginationKey to null (the loop-terminating last page)', () => {
    expect(parseGpaV2Response({ result: { accounts: [], paginationKey: null } })).toEqual({
      pubkeys: [],
      paginationKey: null,
    });
    expect(parseGpaV2Response({ result: { accounts: [] } }).paginationKey).toBeNull();
  });

  it('throws on a JSON-RPC error so a failed discovery never silently returns a partial set (no-miss)', () => {
    expect(() => parseGpaV2Response({ error: { code: -32602, message: 'bad params' } })).toThrow(
      /bad params/,
    );
    expect(() => parseGpaV2Response({})).toThrow(/malformed/);
  });
});
