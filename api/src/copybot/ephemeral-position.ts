/**
 * Copy-bot · Inc.2/3 — ephemeral position keypair, DETERMINISTICALLY derived from the `commandId` (PURE, web3.js only,
 * NOT the SDK → importable by the vault). The DLMM open has 2 signers: the owner (funds key, vault-only) and the
 * position account (disposable: holds only the rent, returned to the owner at close). The brain derives the PUBKEY to
 * build; the vault derives the KEYPAIR to sign — no key transits the bus.
 *
 * PoC: deriving from a public commandId makes the position account griefable (pre-creation = DoS, not theft).
 * Acceptable on a test wallet; the hardened version (vault-only seed) will come with the fortress.
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

export function derivePositionKeypair(commandId: string): Keypair {
  const seed = createHash('sha256').update(commandId).digest().subarray(0, 32);
  return Keypair.fromSeed(seed);
}
