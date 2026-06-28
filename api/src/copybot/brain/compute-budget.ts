/**
 * Copy-bot · BRAIN — ComputeBudget tx helpers (web3.js). Set the compute-unit LIMIT (CU cap) and the compute-unit
 * PRICE (priority fee) on a built DLMM tx before it is serialized for the vault. Pure tx mutation (no I/O, no RPC).
 * Wall B allowlists the ComputeBudget program, so the vault lands these unchanged.
 */
import { ComputeBudgetProgram, type Transaction } from '@solana/web3.js';
import { type PriorityFeeConfig, computeUnitPriceMicroLamports } from '@/domain/copybot/priority-fee';

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const CB_SET_UNIT_LIMIT = 2; // ComputeBudget instruction discriminator (SetComputeUnitLimit)
const CB_SET_UNIT_PRICE = 3; // ComputeBudget instruction discriminator (SetComputeUnitPrice)
const DEFAULT_CU_LIMIT_FOR_PRICE = 200_000; // fallback CU limit for capping the price when a tx carries no explicit limit ix

const firstTx = (t: Transaction | Transaction[]): Transaction => (Array.isArray(t) ? (t[0] as Transaction) : t);
const isCbIx = (ix: { programId: { toBase58(): string }; data: Buffer }, disc: number): boolean =>
  ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === disc;

/** Force an explicit CU limit (the SDK's estimate fails when a token isn't held yet). Replaces any existing limit ix. */
export function withCuLimit(t: Transaction | Transaction[], units: number): Transaction {
  const tx = firstTx(t);
  tx.instructions = tx.instructions.filter((ix) => !isCbIx(ix, CB_SET_UNIT_LIMIT));
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  return tx;
}

const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;

/**
 * Set the priority fee (compute-unit price) on a tx, bounded by the leader's capped tier. Reads the tx's CU limit
 * (the worst case) so `price × cuLimit` never exceeds the cap. An optional live µLamports/CU estimate (from the fee
 * oracle) can raise the tier's static target during congestion; the cap still wins. Replaces any existing price ix
 * (idempotent). Returns the priority lamports this fee will cost at the worst case — used to size the Jito tip
 * within the shared cap.
 */
export function applyPriorityFee(tx: Transaction, pf: PriorityFeeConfig, liveMicroPerCu: number | null = null): number {
  const limitIx = tx.instructions.find((ix) => isCbIx(ix, CB_SET_UNIT_LIMIT));
  const cuLimit = limitIx ? limitIx.data.readUInt32LE(1) : DEFAULT_CU_LIMIT_FOR_PRICE;
  const micro = computeUnitPriceMicroLamports(pf.tier, cuLimit, pf.maxCapSol, liveMicroPerCu);
  tx.instructions = tx.instructions.filter((ix) => !isCbIx(ix, CB_SET_UNIT_PRICE));
  if (micro > 0) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
  return Math.floor((micro * cuLimit) / MICRO_LAMPORTS_PER_LAMPORT);
}
