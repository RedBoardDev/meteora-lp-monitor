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
// PositionClose: position, owner (NO lb_pair, NO bin id) — a standalone close emits only this event.
function closePosition(): string {
  return cpi([255, 196, 16, 107, 28, 202, 53, 128], Buffer.concat([PK(3), PK(9)]));
}
// Rebalancing (IDL field order): lb_pair, position, owner, active_bin_id, x_withdrawn, x_added,
// y_withdrawn, y_added, x_fee, y_fee, old_min/max, new_min/max, rewards[2]. A rebalance may harvest fees.
function rebalancing(o: { xWd?: bigint; xAdd?: bigint; yWd?: bigint; yAdd?: bigint; xFee?: bigint; yFee?: bigint; bin: number }): string {
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v, 0);
    return b;
  };
  const i32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v, 0);
    return b;
  };
  const body = Buffer.concat([
    PK(1), PK(3), PK(9), // lb_pair, position, owner
    i32(o.bin),
    u64(o.xWd ?? 0n), u64(o.xAdd ?? 0n), u64(o.yWd ?? 0n), u64(o.yAdd ?? 0n),
    u64(o.xFee ?? 0n), u64(o.yFee ?? 0n),
    i32(0), i32(0), i32(0), i32(0), // old_min/max, new_min/max
    u64(0n), u64(0n), // rewards[2]
  ]);
  return cpi([0, 109, 117, 179, 61, 91, 199, 200], body);
}
const POSITION = utils.bytes.bs58.encode(PK(3)); // the position pubkey (3rd/1st field of the events above)

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

  // FIX #124: a Rebalancing that harvests fees (x/y_fee_amount) must yield a claim leg alongside its
  // withdraw/deposit legs — else the leader's claim-via-rebalance is not mirrored (claimSol = 0).
  it('decodes a Rebalancing with harvested fees → withdraw + deposit + a claim leg for x/y_fee_amount', () => {
    const legs = decodeDlmmLegs(tx([rebalancing({ xWd: 100n, yWd: 200n, xAdd: 50n, yAdd: 60n, xFee: 7n, yFee: 9n, bin: -12 })]));
    expect(legs.find((l) => l.kind === 'withdraw')).toMatchObject({ amountX: 100n, amountY: 200n, activeBinId: -12 });
    expect(legs.find((l) => l.kind === 'deposit')).toMatchObject({ amountX: 50n, amountY: 60n, activeBinId: -12 });
    // The claim leg is what the OLD code was missing entirely.
    expect(legs.find((l) => l.kind === 'claim')).toMatchObject({ kind: 'claim', amountX: 7n, amountY: 9n, activeBinId: -12 });
  });

  it('decodes a Rebalancing with ZERO fees → no claim leg (only withdraw/deposit)', () => {
    const legs = decodeDlmmLegs(tx([rebalancing({ xWd: 100n, yWd: 200n, xAdd: 50n, yAdd: 60n, bin: -12 })]));
    expect(legs.some((l) => l.kind === 'claim')).toBe(false);
    expect(legs.filter((l) => l.kind === 'withdraw' || l.kind === 'deposit')).toHaveLength(2);
  });

  // NO-MISS-CLOSE PILLAR: a leader that removed 100% earlier and then sends a standalone close emits
  // ONLY a PositionClose event — no capital legs, no bin. Before the fix this decoded to [] (the close
  // was dropped by the default branch AND the bin==null guard), so the fast path never saw the position
  // and the close was only caught 30s later by the reconcile backstop. Now it yields a 'close' marker.
  it('decodes a STANDALONE PositionClose → one zero-amount close marker leg carrying the position', () => {
    const legs = decodeDlmmLegs(tx([closePosition()]));
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      kind: 'close',
      position: POSITION,
      lbPair: '', // PositionClose carries no lb_pair → empty pool is acceptable (mirror looked up by position)
      amountX: 0n,
      amountY: 0n,
      activeBinId: 0, // no price anchor in the tx → neutral placeholder (never used to value a marker)
    });
  });

  // REGRESSION: a NORMAL close (RemoveLiquidity + PositionClose in one tx) must still decode its
  // withdraw leg with EXACT amounts, and ALSO surface the close marker — with the bin borrowed from
  // the sibling Remove event. Amounts of the real leg are unchanged.
  it('decodes a NORMAL close (Remove + PositionClose) → withdraw leg intact + a close marker', () => {
    const legs = decodeDlmmLegs(tx([removeLiquidity(156784710127n, 4039260423n, -429), closePosition()]));
    const w = legs.find((l) => l.kind === 'withdraw')!;
    const c = legs.find((l) => l.kind === 'close')!;
    expect(w).toMatchObject({ amountX: 156784710127n, amountY: 4039260423n, activeBinId: -429 });
    expect(c).toMatchObject({ kind: 'close', position: POSITION, amountX: 0n, amountY: 0n });
    expect(c.activeBinId).toBe(-429); // bin borrowed from the sibling Remove event in the same tx
  });
});
