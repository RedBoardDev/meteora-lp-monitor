/**
 * Copy-bot · Inc.3 — WALL B (PURE, WITHOUT the DLMM SDK — firewall F3). Re-verifies an UNSIGNED decoded tx
 * against the typed `SignRequest` BEFORE any signature. The builder is NOT a trust boundary: the vault
 * re-decodes everything. Decoding via `@solana/web3.js` only (+ pure ATA derivation).
 *
 * Core INVs (v1, spec 10 §4.1): INV-2 signer #1 == owner (+ expected ephemeral position as a signer for an
 * open) · INV-3 every program ∈ allowlist · INV-4/5 every outgoing System-Transfer goes to owner / owner's
 * WSOL-ATA · pool referenced (open/close/claim) · kind consistent. For a 'sell' (Jupiter token→SOL): no DLMM
 * pool is referenced, so instead we bind the swap to owner's ATA of the residual token being sold.
 * (Fine-grained bin intent-bind + Jupiter route decode + INV-6 rate-limit = later hardening.)
 */
import { DLMM_PROGRAM_ID, SOL_MINT } from '@binsight/shared';
import { PublicKey, type Transaction } from '@solana/web3.js';
import { JITO_TIP_ACCOUNTS } from '@/domain/copybot/jito-tip';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM = new PublicKey(TOKEN);
const TOKEN_2022_PROGRAM = new PublicKey(TOKEN_2022);
const WSOL = new PublicKey(SOL_MINT);
/** The two canonical token programs an owner's ATA can be derived under (classic SPL + Token-2022). A residual
 *  leg is often a Token-2022 mint (pump.fun), so a sell must be allowed to touch its Token-2022 ATA too. */
const TOKEN_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

// A SOL transfer to a fixed, public Jito tip account is the ONLY permitted non-owner destination (anti-sandwich
// tip). Capped hard here (defense in depth): even a buggy/compromised builder can't drain funds via an inflated
// "tip" — it can only send a bounded amount to a known Jito account.
const JITO_TIP_SET = new Set(JITO_TIP_ACCOUNTS.map((a) => a.toBase58()));
const MAX_JITO_TIP_LAMPORTS = 10_000_000; // 0.01 SOL hard ceiling (far above the conservative ~0.00005 SOL tip)

// A ComputeBudget priority fee (compute-unit PRICE) is SOL burned to the validator — NOT a System-Transfer, so it
// bypasses the foreign-destination + wrap-cap checks. The brain caps it (applyPriorityFee/maxCapSol), but Wall B
// must NOT trust the brain: an inflated `setComputeUnitPrice` is a drain vector symmetric to (and larger than) the
// Jito tip, which IS already capped. Bound the worst-case fee (price × CU-limit) independently here.
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const CB_SET_UNIT_LIMIT = 2; // ComputeBudget instruction discriminator (SetComputeUnitLimit): [2, u32 units]
const CB_SET_UNIT_PRICE = 3; // ComputeBudget instruction discriminator (SetComputeUnitPrice): [3, u64 microLamports/CU]
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
const PROTOCOL_MAX_CU = 1_400_000n; // Solana per-tx CU ceiling — the worst-case CU when a tx sets a price but no explicit limit (never under-bound the fee)
const MAX_PRIORITY_FEE_LAMPORTS = 50_000_000n; // 0.05 SOL hard ceiling on the worst-case priority fee — ~10× the default 0.005 SOL maxCapSol budget (generous headroom for congestion), but bounds a compromised-brain fee-drain to a tiny amount per tx

const ALLOWED_PROGRAMS = new Set([
  COMPUTE_BUDGET,
  SYSTEM,
  TOKEN,
  TOKEN_2022, // Token-2022 (residual pump.fun-style legs route through it)
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  DLMM_PROGRAM_ID,
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6 (residual token→SOL re-swap)
]);

export interface WallBIntent {
  owner: string;
  pool: string;
  kind: 'open' | 'close' | 'claim' | 'sell' | 'add' | 'remove' | 'buy';
  /** pubkey of the expected ephemeral position (signer for an open). */
  positionPubkey: string;
  /** for a Jupiter swap ('sell' or 'buy'): the swap's NON-SOL token mint (sell = input sold, buy = output bought)
   *  — the swap is bound to owner's ATA of it. */
  inputMint?: string;
  /** hard ceiling (lamports) on the SOL the tx may WRAP into the position/swap (sum of owner→WSOL-ATA transfers).
   *  Bounds the ACTUAL deployed SOL independently of the self-reported sizeSol — defense in depth against a
   *  buggy/compromised brain under-reporting size while the tx moves more. Undefined ⇒ not enforced. */
  maxLamports?: number;
}

export type WallBVerdict = { ok: true } | { ok: false; reason: string };

/** Owner's associated token account for a mint under a specific token program (pure derivation, no spl-token).
 *  The token-program seed differs between classic SPL and Token-2022, yielding distinct ATA addresses. */
function ownerAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): string {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0].toBase58();
}

/** Decodes + verifies an unsigned legacy tx against the intent. Pure, does not throw (returns a verdict). */
export function verifyTx(tx: Transaction, intent: WallBIntent): WallBVerdict {
  const signers = tx.signatures.map((s) => s.publicKey.toBase58());
  if (signers.length === 0 || signers[0] !== intent.owner) return { ok: false, reason: 'signer_not_owner' };
  if (intent.kind === 'open' && !signers.includes(intent.positionPubkey)) {
    return { ok: false, reason: 'missing_position_signer' };
  }

  const ownerWsolAta = ownerAta(new PublicKey(intent.owner), WSOL, TOKEN_PROGRAM); // the SOL the tx wraps for deployment/swap
  let wrapLamports = 0n; // sum of owner→WSOL-ATA System-Transfers = the ACTUAL SOL this tx deploys
  let cbUnitLimit: bigint | null = null; // explicit ComputeBudget CU limit, if the tx sets one
  let cbUnitPriceMicro = 0n; // ComputeBudget CU price (microLamports/CU) → the priority fee
  const accountKeys = new Set<string>();
  for (const ix of tx.instructions) {
    const prog = ix.programId.toBase58();
    if (!ALLOWED_PROGRAMS.has(prog)) return { ok: false, reason: `program_not_allowed:${prog}` };
    for (const k of ix.keys) accountKeys.add(k.pubkey.toBase58());

    // Decode the ComputeBudget priority fee so the worst case (price × CU-limit) can be capped below — a drain vector
    // Wall B must bound independently of the brain (the fee is burned, not transferred, so the wrap-cap can't catch it).
    if (prog === COMPUTE_BUDGET) {
      if (ix.data.length >= 5 && ix.data[0] === CB_SET_UNIT_LIMIT) cbUnitLimit = BigInt(ix.data.readUInt32LE(1));
      if (ix.data.length >= 9 && ix.data[0] === CB_SET_UNIT_PRICE) cbUnitPriceMicro = ix.data.readBigUInt64LE(1);
    }

    // INV-4/5: an outgoing System-Transfer (instruction index 2) must target owner or their WSOL ATA.
    if (prog === SYSTEM && ix.data.length >= 4 && ix.data.readUInt32LE(0) === 2) {
      const from = ix.keys[0]?.pubkey.toBase58();
      const to = ix.keys[1]?.pubkey.toBase58();
      const lamports = ix.data.length >= 12 ? ix.data.readBigUInt64LE(4) : 0n;
      if (from === intent.owner && to === ownerWsolAta) wrapLamports += lamports; // capital wrapped for the deposit/swap
      if (from === intent.owner && to !== intent.owner && to !== ownerWsolAta) {
        // The ONE allowed non-owner SOL destination: a capped tip to a known Jito tip account (anti-sandwich).
        if (to !== undefined && JITO_TIP_SET.has(to)) {
          if (lamports > BigInt(MAX_JITO_TIP_LAMPORTS)) return { ok: false, reason: 'jito_tip_too_large' };
        } else {
          return { ok: false, reason: 'foreign_sol_destination' };
        }
      }
    }
  }

  // Priority-fee cap (defense in depth, ALL kinds): the worst-case fee = price × CU-limit. Use the explicit CU limit
  // if the tx sets one, else the protocol per-tx ceiling (never under-bound). A compromised brain that inflates the
  // compute-unit price to drain SOL via fees is rejected here, even though the fee is not a System-Transfer.
  const worstCaseFeeLamports = (cbUnitPriceMicro * (cbUnitLimit ?? PROTOCOL_MAX_CU)) / MICRO_LAMPORTS_PER_LAMPORT;
  if (worstCaseFeeLamports > MAX_PRIORITY_FEE_LAMPORTS) return { ok: false, reason: 'priority_fee_too_large' };

  // SOL-spend cap (defense in depth): the ACTUAL wrapped SOL must stay under the caller's ceiling, regardless of the
  // self-reported sizeSol. Closes/removes/claims/sells wrap nothing (0 ≤ cap). The ceiling is generous (covers rent +
  // slippage) so it only catches a GROSS over-spend, never false-rejects a legitimate deposit/buy.
  if (intent.maxLamports !== undefined && wrapLamports > BigInt(intent.maxLamports)) return { ok: false, reason: 'sol_spend_over_cap' };

  // A 'sell' (token→SOL) or 'buy' (SOL→token) is a Jupiter swap: no DLMM pool is referenced. Bind it to owner's
  // ATA of the swap's non-SOL token (sell = the residual sold, buy = the token bought for a two-sided copy) —
  // proves the swap touches the intended token's account, not some other holding.
  if (intent.kind === 'sell' || intent.kind === 'buy') {
    if (!intent.inputMint) return { ok: false, reason: 'swap_missing_token_mint' };
    const owner = new PublicKey(intent.owner);
    const mint = new PublicKey(intent.inputMint);
    // Accept the swap if it touches owner's ATA of the token under EITHER token program (the mint's program is
    // not known here without I/O; both derivations are owner-bound, so either is safe to accept).
    const touchesOwnerAta = TOKEN_PROGRAMS.some((tp) => accountKeys.has(ownerAta(owner, mint, tp)));
    if (!touchesOwnerAta) return { ok: false, reason: 'swap_token_not_owner_ata' };
    return { ok: true };
  }

  // Every DLMM op must reference our pool — EXCEPT an empty-position close: `closePositionIfEmpty` (used when a
  // position has no liquidity, e.g. a leader emptied it) reclaims rent and touches NO pool reserves, so the pool
  // pubkey isn't in the tx — only our position. Accept the position binding for a CLOSE only (closing our own empty
  // position is harmless, never a drain); all other kinds stay strictly pool-bound. Without this an emptied position
  // can't be closed → dormant (violates the no-miss-close pillar).
  const closeRefsOurPosition = intent.kind === 'close' && accountKeys.has(intent.positionPubkey);
  if (!accountKeys.has(intent.pool) && !closeRefsOurPosition) return { ok: false, reason: 'pool_not_referenced' };
  return { ok: true };
}
