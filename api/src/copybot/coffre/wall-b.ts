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
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { PublicKey, type Transaction } from '@solana/web3.js';
import { JITO_TIP_ACCOUNTS } from '@/domain/copybot/jito-tip';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM = new PublicKey(TOKEN);
const TOKEN_2022_PROGRAM = new PublicKey(TOKEN_2022);
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
/** The two canonical token programs an owner's ATA can be derived under (classic SPL + Token-2022). A residual
 *  leg is often a Token-2022 mint (pump.fun), so a sell must be allowed to touch its Token-2022 ATA too. */
const TOKEN_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

// A SOL transfer to a fixed, public Jito tip account is the ONLY permitted non-owner destination (anti-sandwich
// tip). Capped hard here (defense in depth): even a buggy/compromised builder can't drain funds via an inflated
// "tip" — it can only send a bounded amount to a known Jito account.
const JITO_TIP_SET = new Set(JITO_TIP_ACCOUNTS.map((a) => a.toBase58()));
const MAX_JITO_TIP_LAMPORTS = 10_000_000; // 0.01 SOL hard ceiling (far above the conservative ~0.00005 SOL tip)

const ALLOWED_PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',
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

  const accountKeys = new Set<string>();
  for (const ix of tx.instructions) {
    const prog = ix.programId.toBase58();
    if (!ALLOWED_PROGRAMS.has(prog)) return { ok: false, reason: `program_not_allowed:${prog}` };
    for (const k of ix.keys) accountKeys.add(k.pubkey.toBase58());

    // INV-4/5: an outgoing System-Transfer (instruction index 2) must target owner or their WSOL ATA.
    if (prog === SYSTEM && ix.data.length >= 4 && ix.data.readUInt32LE(0) === 2) {
      const from = ix.keys[0]?.pubkey.toBase58();
      const to = ix.keys[1]?.pubkey.toBase58();
      if (from === intent.owner && to !== intent.owner && to !== ownerAta(new PublicKey(intent.owner), WSOL, TOKEN_PROGRAM)) {
        // The ONE allowed non-owner SOL destination: a capped tip to a known Jito tip account (anti-sandwich).
        if (to !== undefined && JITO_TIP_SET.has(to)) {
          const tipLamports = ix.data.length >= 12 ? ix.data.readBigUInt64LE(4) : BigInt(MAX_JITO_TIP_LAMPORTS) + 1n;
          if (tipLamports > BigInt(MAX_JITO_TIP_LAMPORTS)) return { ok: false, reason: 'jito_tip_too_large' };
        } else {
          return { ok: false, reason: 'foreign_sol_destination' };
        }
      }
    }
  }

  // A 'sell' (token→SOL) or 'buy' (SOL→token) is a Jupiter swap: no DLMM pool is referenced. Bind it to owner's
  // ATA of the swap's non-SOL token (sell = the residual sold, buy = the token bought for a two-sided copy) —
  // proves the swap touches the intended token's account, not some other holding. (The SOL spend cap on a buy is
  // re-clamped against the local config by the coffre; Wall B already blocks any non-owner SOL destination above.)
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

  if (!accountKeys.has(intent.pool)) return { ok: false, reason: 'pool_not_referenced' };
  return { ok: true };
}
