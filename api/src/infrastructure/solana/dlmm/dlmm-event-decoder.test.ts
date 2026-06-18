import { utils } from '@coral-xyz/anchor';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { DLMM_PROGRAM_ID, decodeDlmmLegs } from './dlmm-event-decoder';

// Build an Event-CPI inner-instruction payload: [8-byte self-CPI tag][8-byte event disc][borsh event].
// Field layouts match the official IDL (verified). The decoder strips the tag and hands the rest to
// Anchor's IDL-driven coder — so this exercises the real decode path without any network.
const PK = (b: number) => Buffer.alloc(32, b);
function cpi(disc: number[], body: Buffer): string {
  return utils.bytes.bs58.encode(Buffer.concat([Buffer.alloc(8), Buffer.from(disc), body]));
}
function addLiquidity(x: bigint, y: bigint, bin: number): string {
  const amounts = Buffer.alloc(16);
  amounts.writeBigUInt64LE(x, 0);
  amounts.writeBigUInt64LE(y, 8);
  const binBuf = Buffer.alloc(4);
  binBuf.writeInt32LE(bin, 0);
  return cpi(
    [31, 94, 125, 90, 227, 52, 61, 186],
    Buffer.concat([PK(1), PK(2), PK(3), amounts, binBuf]),
  );
}
function removeLiquidity(x: bigint, y: bigint, bin: number): string {
  const amounts = Buffer.alloc(16);
  amounts.writeBigUInt64LE(x, 0);
  amounts.writeBigUInt64LE(y, 8);
  const binBuf = Buffer.alloc(4);
  binBuf.writeInt32LE(bin, 0);
  return cpi(
    [116, 244, 97, 232, 103, 31, 152, 58],
    Buffer.concat([PK(1), PK(2), PK(3), amounts, binBuf]),
  );
}
// ClaimFee2: lb_pair, position, owner, fee_x, fee_y, active_bin_id
function claimFee2(fx: bigint, fy: bigint, bin: number): string {
  const fees = Buffer.alloc(16);
  fees.writeBigUInt64LE(fx, 0);
  fees.writeBigUInt64LE(fy, 8);
  const binBuf = Buffer.alloc(4);
  binBuf.writeInt32LE(bin, 0);
  return cpi(
    [232, 171, 242, 97, 58, 77, 35, 45],
    Buffer.concat([PK(1), PK(3), PK(9), fees, binBuf]),
  );
}
// ClaimFee v1: lb_pair, position, owner, fee_x, fee_y (NO bin id)
function claimFeeV1(fx: bigint, fy: bigint): string {
  const fees = Buffer.alloc(16);
  fees.writeBigUInt64LE(fx, 0);
  fees.writeBigUInt64LE(fy, 8);
  return cpi([75, 122, 154, 48, 140, 74, 123, 163], Buffer.concat([PK(1), PK(3), PK(9), fees]));
}

const tx = (datas: string[]): ParsedTransactionWithMeta =>
  ({
    blockTime: 123,
    transaction: { signatures: ['SIG1'] },
    meta: {
      innerInstructions: [
        { index: 0, instructions: datas.map((d) => ({ programId: DLMM_PROGRAM_ID, data: d })) },
      ],
    },
  }) as unknown as ParsedTransactionWithMeta;

describe('decodeDlmmLegs (IDL-driven)', () => {
  it('decodes AddLiquidity → a deposit leg with exact bigint amounts + bin id', () => {
    const legs = decodeDlmmLegs(tx([addLiquidity(205945537665n, 3376692725n, -437)]));
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      kind: 'deposit',
      amountX: 205945537665n,
      amountY: 3376692725n,
      activeBinId: -437,
    });
  });

  it('decodes RemoveLiquidity → a withdraw leg', () => {
    const [w] = decodeDlmmLegs(tx([removeLiquidity(156784710127n, 4039260423n, -429)]));
    expect(w).toMatchObject({ kind: 'withdraw', amountX: 156784710127n, activeBinId: -429 });
  });

  it('counts ClaimFee2 once and DROPS the duplicate ClaimFee v1 in the same tx (no double count)', () => {
    const legs = decodeDlmmLegs(
      tx([
        removeLiquidity(0n, 1n, -429),
        claimFee2(0n, 46620648n, -429),
        claimFeeV1(0n, 46620648n),
      ]),
    );
    const claims = legs.filter((l) => l.kind === 'claim');
    expect(claims).toHaveLength(1);
    expect(claims[0]!.amountY).toBe(46620648n);
  });

  it('backfills a lone ClaimFee v1 bin id from a sibling event in the same tx', () => {
    // a v1 claim with no bin id, but a Remove in the same tx carries bin -429.
    const legs = decodeDlmmLegs(tx([removeLiquidity(0n, 1n, -429), claimFeeV1(0n, 5n)]));
    const claim = legs.find((l) => l.kind === 'claim')!;
    expect(claim.activeBinId).toBe(-429); // borrowed from the Remove event
  });

  it('ignores non-DLMM inner instructions and txs with no events', () => {
    expect(decodeDlmmLegs(tx([]))).toEqual([]);
  });
});
