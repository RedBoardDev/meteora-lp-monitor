import {
  DLMM_PROGRAM_ID as DLMM_PROGRAM_ID_STR,
  POSITION_V2_DISCRIMINATOR,
} from '@binsight/shared';
import { PublicKey } from '@solana/web3.js';

/**
 * On-chain DLMM account layouts (lb_clmm program). Byte offsets validated against the datapi
 * to the lamport on 13+ live positions (see docs/research/backend-validation-report.md §1).
 * Ported from scripts/spike/onchain_value.py (the canonical, report-endorsed spike).
 */

export const DLMM_PROGRAM_ID = new PublicKey(DLMM_PROGRAM_ID_STR);

export const POSITION_V2_DISC = POSITION_V2_DISCRIMINATOR;
export const LBPAIR_DISC = [33, 11, 49, 98, 181, 101, 177, 13] as const;

export const BINS_PER_ARRAY = 70;
export const POSITION_FIXED_SIZE = 8120; // discriminator(8) + 8112-byte body (70 inline bins)
const INLINE_BINS = 70;
const EXT_BIN_RECORD_SIZE = 112; // PositionBinData appended past 70 bins (up to 1400 total)
const BIN_SIZE = 144;
const BIN_ARRAY_BINS_OFFSET = 56;

// ── little-endian readers ───────────────────────────────────────────────────
const U128_MASK = (1n << 128n) - 1n;

function leBig(b: Uint8Array, o: number, len: number): bigint {
  let r = 0n;
  for (let i = len - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[o + i]!);
  return r;
}
const u64 = (b: Uint8Array, o: number): bigint => leBig(b, o, 8);
const u128 = (b: Uint8Array, o: number): bigint => leBig(b, o, 16);
function i32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset + o, 4).getInt32(0, true);
}
const u16 = (b: Uint8Array, o: number): number =>
  new DataView(b.buffer, b.byteOffset + o, 2).getUint16(0, true);
const readPk = (b: Uint8Array, o: number): PublicKey => new PublicKey(b.subarray(o, o + 32));

function discMatches(b: Uint8Array, disc: readonly number[]): boolean {
  for (let i = 0; i < 8; i++) if (b[i] !== disc[i]) return false;
  return true;
}

// ── PositionV2 ────────────────────────────────────────────────────────────────
export interface BinFeeInfo {
  completeX: bigint;
  completeY: bigint;
  pendingX: bigint;
  pendingY: bigint;
}
export interface DecodedPosition {
  lbPair: PublicKey;
  owner: PublicKey;
  lowerBinId: number;
  upperBinId: number;
  /** liquidity share per bin, lowerBinId..upperBinId inclusive. */
  shares: bigint[];
  feeInfos: BinFeeInfo[];
}

export function decodePosition(data: Uint8Array): DecodedPosition {
  if (!discMatches(data, POSITION_V2_DISC)) {
    throw new Error(`not a PositionV2 account (disc ${Array.from(data.subarray(0, 8))})`);
  }
  const lowerBinId = i32(data, 7912);
  const upperBinId = i32(data, 7916);
  const width = upperBinId - lowerBinId + 1;
  const shares: bigint[] = [];
  const feeInfos: BinFeeInfo[] = [];
  for (let j = 0; j < width; j++) {
    if (j < INLINE_BINS) {
      shares.push(u128(data, 72 + 16 * j));
      const o = 4552 + 48 * j;
      feeInfos.push({
        completeX: u128(data, o),
        completeY: u128(data, o + 16),
        pendingX: u64(data, o + 32),
        pendingY: u64(data, o + 40),
      });
    } else {
      const base = POSITION_FIXED_SIZE + EXT_BIN_RECORD_SIZE * (j - INLINE_BINS);
      shares.push(u128(data, base));
      const fo = base + 64; // fee_info sub-offset within the 112-byte PositionBinData record
      feeInfos.push({
        completeX: u128(data, fo),
        completeY: u128(data, fo + 16),
        pendingX: u64(data, fo + 32),
        pendingY: u64(data, fo + 40),
      });
    }
  }
  return {
    lbPair: readPk(data, 8),
    owner: readPk(data, 40),
    lowerBinId,
    upperBinId,
    shares,
    feeInfos,
  };
}

/** Cheap header-only decode for position discovery (range + pool), no per-bin work. */
export function decodePositionHeader(data: Uint8Array): {
  lbPair: PublicKey;
  owner: PublicKey;
  lowerBinId: number;
  upperBinId: number;
} {
  if (!discMatches(data, POSITION_V2_DISC)) throw new Error('not a PositionV2 account');
  return {
    lbPair: readPk(data, 8),
    owner: readPk(data, 40),
    lowerBinId: i32(data, 7912),
    upperBinId: i32(data, 7916),
  };
}

// ── LbPair ─────────────────────────────────────────────────────────────────────
export interface DecodedLbPair {
  activeId: number;
  binStep: number;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  xProgramFlag: number;
  yProgramFlag: number;
}

export function decodeLbPair(data: Uint8Array): DecodedLbPair {
  if (!discMatches(data, LBPAIR_DISC)) throw new Error('not an LbPair account');
  return {
    activeId: i32(data, 76),
    binStep: u16(data, 80),
    tokenXMint: readPk(data, 88),
    tokenYMint: readPk(data, 120),
    xProgramFlag: data[880]!,
    yProgramFlag: data[881]!,
  };
}

// ── Bin (inside a BinArray) ─────────────────────────────────────────────────────
export interface DecodedBin {
  amountX: bigint;
  amountY: bigint;
  liquiditySupply: bigint;
  feeXPerTokenStored: bigint;
  feeYPerTokenStored: bigint;
}

/** Decode bin at sub-index `sub` (0..69) inside a BinArray account. Fee accumulators at 80/96. */
export function decodeBin(binArray: Uint8Array, sub: number): DecodedBin {
  const o = BIN_ARRAY_BINS_OFFSET + BIN_SIZE * sub;
  return {
    amountX: u64(binArray, o),
    amountY: u64(binArray, o + 8),
    liquiditySupply: u128(binArray, o + 32),
    feeXPerTokenStored: u128(binArray, o + 80),
    feeYPerTokenStored: u128(binArray, o + 96),
  };
}

// ── bin / bin-array math ─────────────────────────────────────────────────────────
/** Bin array index covering a bin id (floor toward -inf). */
export function binToArrayIndex(binId: number): number {
  return Math.floor(binId / BINS_PER_ARRAY);
}

/** BinArray PDA: seeds = ["bin_array", lbPair, i64LE(index)] on the DLMM program. */
export function deriveBinArray(lbPair: PublicKey, index: number): PublicKey {
  const idx = Buffer.alloc(8);
  idx.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bin_array'), lbPair.toBuffer(), idx],
    DLMM_PROGRAM_ID,
  )[0];
}

export const wrapU128 = (x: bigint): bigint => x & U128_MASK;
