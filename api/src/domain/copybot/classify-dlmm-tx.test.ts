import { utils } from '@coral-xyz/anchor';
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { LoadedPoolMeta } from '../dlmm';
import { classifyInstruction } from '../dlmm';
import { type PoolMetaLookup, buildDetectedEvent, poolsOf } from './classify-dlmm-tx';

// --- Event-CPI event builders at the REAL byte layout (same technique as dlmm-event-decoder.test.ts:
// [8 self-CPI tag][8 disc][borsh]) → we exercise the real decoding path, without the network. lb_pair = PK(1). ---
const PK = (b: number) => Buffer.alloc(32, b);
const cpi = (disc: number[], body: Buffer): string =>
  utils.bytes.bs58.encode(Buffer.concat([Buffer.alloc(8), Buffer.from(disc), body]));
const amounts = (x: bigint, y: bigint): Buffer => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(x, 0);
  b.writeBigUInt64LE(y, 8);
  return b;
};
const binBuf = (bin: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(bin, 0);
  return b;
};
const addLiquidity = (x: bigint, y: bigint, bin: number): string =>
  cpi([31, 94, 125, 90, 227, 52, 61, 186], Buffer.concat([PK(1), PK(2), PK(3), amounts(x, y), binBuf(bin)]));
const removeLiquidity = (x: bigint, y: bigint, bin: number): string =>
  cpi([116, 244, 97, 232, 103, 31, 152, 58], Buffer.concat([PK(1), PK(2), PK(3), amounts(x, y), binBuf(bin)]));
const claimFee2 = (fx: bigint, fy: bigint, bin: number): string =>
  cpi([232, 171, 242, 97, 58, 77, 35, 45], Buffer.concat([PK(1), PK(3), PK(9), amounts(fx, fy), binBuf(bin)]));
// PositionClose: position, owner (NO lb_pair, NO bin id) — a standalone close emits only this event.
const closePosition = (): string =>
  cpi([255, 196, 16, 107, 28, 202, 53, 128], Buffer.concat([PK(3), PK(9)]));

const LB_PAIR = utils.bytes.bs58.encode(PK(1)); // the lb_pair carried by the events above
const POSITION = utils.bytes.bs58.encode(PK(3)); // the position pubkey (3rd pubkey field of the events above)

const SOL = 'So11111111111111111111111111111111111111112';
const NONSOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// SOL on side Y + bin 0 (price = 1) → legValueSol equals exactly amountY/1e9. Deterministic, no bin math.
const SOL_Y: LoadedPoolMeta = { binStep: 1, solSide: 'Y', mintX: NONSOL, mintY: SOL };
const lookupSolY: PoolMetaLookup = () => SOL_Y;

// minimal parsed tx: logs (for the DLMM filter + parseInstruction) + innerInstructions (the CPI events).
function tx(instr: string, datas: string[], blockTime: number | null = 1_700_000_000): ParsedTransactionWithMeta {
  return {
    blockTime,
    transaction: { signatures: ['SIG1'] },
    meta: {
      logMessages: [
        `Program ${DLMM_PROGRAM_ID} invoke [1]`,
        `Program log: Instruction: ${instr}`,
        `Program ${DLMM_PROGRAM_ID} success`,
      ],
      innerInstructions: [{ index: 0, instructions: datas.map((d) => ({ programId: DLMM_PROGRAM_ID, data: d })) }],
    },
  } as unknown as ParsedTransactionWithMeta;
}

// Same shape as `tx()` but with logs that DO NOT mention the DLMM program — simulates Solana's 10KB
// logMessages truncation (a DLMM ix after a big Jupiter bundle): the inner CPI events are intact, the log
// string is gone. The OLD log-gated classifier returned null here → a PERMANENT miss of the leader event.
function txLogsTruncated(datas: string[], blockTime: number | null = 1_700_000_000): ParsedTransactionWithMeta {
  return {
    blockTime,
    transaction: { signatures: ['SIG1'] },
    meta: {
      logMessages: ['Program JUP... invoke [1]', 'Program log: truncated'], // NO DLMM program id, NO Instruction: line
      innerInstructions: [{ index: 0, instructions: datas.map((d) => ({ programId: DLMM_PROGRAM_ID, data: d })) }],
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('buildDetectedEvent — no-miss gate keys off DLMM EVENTS, not logs (10KB truncation)', () => {
  // NO-MISS PILLAR: gating DLMM-ness on logMessages loses any DLMM ix whose program string was truncated
  // past 10KB. The gate now reads the inner Event-CPI (`hasDlmmEvents`) → the event is STILL detected.
  it('DLMM events present but logs truncated (no program id) → event is DETECTED (was null before)', () => {
    const e = buildDetectedEvent('sigTrunc', txLogsTruncated([addLiquidity(0n, 1_500_000_000n, 0)]), lookupSolY);
    expect(e).not.toBeNull(); // the whole point: no-miss even under log truncation
    expect(e?.depositSol).toBeCloseTo(1.5, 9);
    expect(e?.instruction).toBe('(DLMM)'); // no Instruction: line in the truncated logs → best-effort label
    expect(e?.position).toBe(POSITION);
  });

  it('a close whose logs are truncated → closed === true and withdrawSol intact (routing key survives)', () => {
    const e = buildDetectedEvent('sigTruncClose', txLogsTruncated([removeLiquidity(0n, 2_000_000_000n, 0), closePosition()]), lookupSolY);
    expect(e).not.toBeNull();
    expect(e?.closed).toBe(true); // the robust close signal — independent of the (truncated) log label
    expect(e?.withdrawSol).toBeCloseTo(2, 9);
  });

  it('a NON-DLMM tx (no inner DLMM events) → still null (gate is not looser than before)', () => {
    const nonDlmm = {
      blockTime: 1,
      transaction: { signatures: ['SIG1'] },
      meta: { logMessages: ['Program 11111111111111111111111111111111 invoke [1]'], innerInstructions: [] },
    } as unknown as ParsedTransactionWithMeta;
    expect(buildDetectedEvent('sigOther', nonDlmm, lookupSolY)).toBeNull();
  });
});

describe('buildDetectedEvent — `closed` flag (robust close signal for routing)', () => {
  it('STANDALONE close (only PositionClose) → closed === true, all amounts 0', () => {
    const e = buildDetectedEvent('sigStandalone', tx('ClosePosition2', [closePosition()]), lookupSolY);
    expect(e?.closed).toBe(true);
    expect(e?.depositSol).toBe(0);
    expect(e?.withdrawSol).toBe(0);
    expect(e?.claimSol).toBe(0);
  });

  it('NORMAL close (Remove + PositionClose) → closed === true AND withdrawSol > 0', () => {
    const e = buildDetectedEvent('sigNormal', tx('ClosePosition2', [removeLiquidity(0n, 2_000_000_000n, 0), closePosition()]), lookupSolY);
    expect(e?.closed).toBe(true);
    expect(e?.withdrawSol).toBeCloseTo(2, 9);
  });

  it('a plain OPEN (no PositionClose) → closed === false', () => {
    const e = buildDetectedEvent('sigOpen', tx('InitializePositionPda', [addLiquidity(0n, 1_500_000_000n, 0)]), lookupSolY);
    expect(e?.closed).toBe(false);
  });

  it('a partial REMOVE (no PositionClose) → closed === false (not a full close)', () => {
    const e = buildDetectedEvent('sigPartial', tx('RemoveLiquidityByRange2', [removeLiquidity(0n, 500_000_000n, 0)]), lookupSolY);
    expect(e?.closed).toBe(false);
    expect(e?.withdrawSol).toBeCloseTo(0.5, 9);
  });
});

describe('buildDetectedEvent — routing DLMM legs into SOL (golden: open/close/claim/partial withdrawal)', () => {
  it('OPEN (AddLiquidity) → all the capital in depositSol, nothing elsewhere', () => {
    const e = buildDetectedEvent('sigOpen', tx('InitializePositionPda', [addLiquidity(0n, 1_500_000_000n, 0)]), lookupSolY);
    expect(e).not.toBeNull();
    expect(e?.instruction).toBe('InitializePositionPda');
    expect(e?.depositSol).toBeCloseTo(1.5, 9);
    expect(e?.withdrawSol).toBe(0);
    expect(e?.claimSol).toBe(0);
    expect(e?.pool).toBe(LB_PAIR);
    expect(e?.position).toBe(POSITION); // surfaced from the leg → P2 tracker key
    expect(e?.nonSolMint).toBe(NONSOL); // SOL is on side Y → the non-SOL is mintX
    expect(e?.blockTime).toBe(1_700_000_000);
    expect(e?.depositTokenRaw).toBe(0); // one-sided SOL open (X=0) → no token leg
  });

  // WHY: the two-sided decision must come from the leader's tx DECODE (authoritative), NOT the per-bin shape read
  // (which can race per-leg on-chain indexing → a partial read would misclassify a two-sided open as one-sided = a
  // forbidden half copy). depositTokenRaw surfaces the raw NON-SOL units deposited so the brain knows to wait for both
  // legs before classifying. A regression that drops the token-leg amount would make this 0 → caught here.
  it('TWO-SIDED open → depositTokenRaw carries the raw NON-SOL amount (authoritative two-sided signal)', () => {
    const e = buildDetectedEvent('sigTwo', tx('AddLiquidityByStrategy2', [addLiquidity(2_000_000n, 1_500_000_000n, 0)]), lookupSolY);
    expect(e?.depositSol).toBeGreaterThan(1.5); // BOTH legs valued in SOL (1.5 SOL + the token leg's SOL value)
    expect(e?.depositTokenRaw).toBe(2_000_000); // NON-SOL (X) leg → marks it two-sided
  });

  it('TWO-SIDED open → depositTokenRaw SUMS the non-SOL leg across multiple Adds in one tx', () => {
    const e = buildDetectedEvent('sigTwoMulti', tx('AddLiquidityByStrategy2', [addLiquidity(2_000_000n, 1_000_000_000n, 0), addLiquidity(500_000n, 250_000_000n, 0)]), lookupSolY);
    expect(e?.depositTokenRaw).toBe(2_500_000); // 2.0M + 0.5M
  });

  it('CLOSE (RemoveLiquidity + ClaimFee2) → capital out in withdrawSol AND fees in claimSol, no deposit', () => {
    const e = buildDetectedEvent(
      'sigClose',
      tx('ClosePosition2', [removeLiquidity(0n, 2_000_000_000n, 0), claimFee2(0n, 125_000_000n, 0)]),
      lookupSolY,
    );
    expect(e?.depositSol).toBe(0);
    expect(e?.withdrawSol).toBeCloseTo(2, 9);
    expect(e?.claimSol).toBeCloseTo(0.125, 9); // the close fees do NOT mix with the withdrawn capital
    expect(e?.position).toBe(POSITION); // remove + claim of the same position → consistent key
  });

  // NO-MISS-CLOSE PILLAR: a leader that removed 100% earlier then sends a standalone close emits ONLY a
  // PositionClose event. Before the fix the DetectedEvent's `position` stayed '' (legs were empty), so the
  // brain's tracker could not match the mirror and the fast-path close never routed (only the 30s reconcile
  // caught it). The close marker now surfaces the position, and parseInstruction classifies it 'close' → routes.
  it('STANDALONE close (only PositionClose) → position surfaced + instruction classifies as close', () => {
    const e = buildDetectedEvent('sigStandaloneClose', tx('ClosePosition2', [closePosition()]), lookupSolY);
    expect(e).not.toBeNull();
    expect(e?.position).toBe(POSITION); // THE BUG: was '' → tracker could not key the mirror → close missed on fast path
    expect(classifyInstruction(e!.instruction)).toBe('close'); // dispatch routes 'close' off this
    expect(e?.depositSol).toBe(0);
    expect(e?.withdrawSol).toBe(0);
    expect(e?.claimSol).toBe(0);
    expect(e?.pool).toBe(''); // PositionClose carries no lb_pair; empty pool is fine (mirror keyed by position)
  });

  // REGRESSION: a NORMAL close (Remove + PositionClose) must keep the REAL pool from the withdraw leg — the
  // zero-amount close marker (empty lbPair) appended after it must NOT clobber `pool`, and amounts are intact.
  it('NORMAL close (Remove + PositionClose) → real pool preserved, withdraw amount intact, position kept', () => {
    const e = buildDetectedEvent('sigNormalClose', tx('ClosePosition2', [removeLiquidity(0n, 2_000_000_000n, 0), closePosition()]), lookupSolY);
    expect(e?.pool).toBe(LB_PAIR); // NOT clobbered to '' by the trailing close marker
    expect(e?.position).toBe(POSITION);
    expect(e?.withdrawSol).toBeCloseTo(2, 9); // capital-out unchanged
    expect(e?.depositSol).toBe(0);
  });

  it('CLAIM alone (ClaimFee2) → only claimSol', () => {
    const e = buildDetectedEvent('sigClaim', tx('ClaimFee2', [claimFee2(0n, 250_000_000n, 0)]), lookupSolY);
    expect(e?.depositSol).toBe(0);
    expect(e?.withdrawSol).toBe(0);
    expect(e?.claimSol).toBeCloseTo(0.25, 9);
  });

  it('PARTIAL WITHDRAWAL (RemoveLiquidity, without close) → same path as a close on the withdrawSol side', () => {
    const e = buildDetectedEvent('sigPartial', tx('RemoveLiquidityByRange2', [removeLiquidity(0n, 500_000_000n, 0)]), lookupSolY);
    expect(e?.instruction).toBe('RemoveLiquidityByRange2');
    expect(e?.withdrawSol).toBeCloseTo(0.5, 9);
    expect(e?.depositSol).toBe(0);
    expect(e?.claimSol).toBe(0);
  });

  it('multiple Adds in one tx → depositSol sums the legs (never overwritten)', () => {
    const e = buildDetectedEvent(
      'sigMulti',
      tx('AddLiquidityByStrategy2', [addLiquidity(0n, 1_000_000_000n, 0), addLiquidity(0n, 250_000_000n, 0)]),
      lookupSolY,
    );
    expect(e?.depositSol).toBeCloseTo(1.25, 9);
  });

  it('pool present but NOT valuable in SOL (solSide null) → event KEPT, amounts at 0, nonSolMint null', () => {
    const noSol: PoolMetaLookup = () => ({ binStep: 1, solSide: null, mintX: NONSOL, mintY: 'OtherMintNotSol111111111111111111111111111' });
    const e = buildDetectedEvent('sigNoSol', tx('AddLiquidityByStrategy2', [addLiquidity(0n, 9n, 0)]), noSol);
    expect(e).not.toBeNull(); // we NEVER lose the action — no-miss pillar
    expect(e?.depositSol).toBe(0);
    expect(e?.nonSolMint).toBeNull();
    expect(e?.pool).toBe(LB_PAIR); // the pool stays populated
  });

  it('meta absent for the pool (lookup → null) → action kept without amount', () => {
    const e = buildDetectedEvent('sigUnknown', tx('AddLiquidityByStrategy2', [addLiquidity(0n, 9n, 0)]), () => null);
    expect(e?.depositSol).toBe(0);
    expect(e?.nonSolMint).toBeNull();
  });

  it('NON-DLMM tx (no log from the program) → null (filtered out)', () => {
    const nonDlmm = {
      blockTime: 1,
      transaction: { signatures: ['SIG1'] },
      meta: { logMessages: ['Program 11111111111111111111111111111111 invoke [1]'], innerInstructions: [] },
    } as unknown as ParsedTransactionWithMeta;
    expect(buildDetectedEvent('sigOther', nonDlmm, lookupSolY)).toBeNull();
  });

  it('absent tx (null) → null', () => {
    expect(buildDetectedEvent('sigNull', null, lookupSolY)).toBeNull();
  });

  it('blockTime absent → null (no misleading 0)', () => {
    const e = buildDetectedEvent('sigNoTime', tx('ClaimFee2', [claimFee2(0n, 1n, 0)], null), lookupSolY);
    expect(e?.blockTime).toBeNull();
  });

  it('poolsOf lists the touched lbPairs (meta pre-loading) and tolerates null', () => {
    expect(poolsOf(tx('ClaimFee2', [claimFee2(0n, 1n, 0)]))).toEqual([LB_PAIR]);
    expect(poolsOf(null)).toEqual([]);
  });
});
