/**
 * Copy-bot · Inc.3/4 — loading of the COPIER wallet key (zone Z3). This is the ONLY module that reads a private
 * key; the import-firewall (dependency-cruiser) forbids any other module from importing it. The brain therefore
 * cannot reference the key.
 *
 * THE-TRAP (PoC): at boot we assert that the loaded key IS indeed the expected copier wallet (≠ leader, ≠ other)
 * — fail-closed otherwise. (Fortress version: 2-of-N quorum, owner ≠ signer, Privy TEE.)
 */
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

export function loadCopierKeypair(path: string, expectedOwner: string): Keypair {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  if (kp.publicKey.toBase58() !== expectedOwner) {
    throw new Error(`THE-TRAP: loaded key ${kp.publicKey.toBase58()} ≠ expected owner ${expectedOwner} — aborting.`);
  }
  return kp;
}
