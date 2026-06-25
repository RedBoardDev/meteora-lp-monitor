/**
 * Copy-bot · Inc.4 — landing (sending the signed tx). Helius fast path: `sendRawTransaction` skipPreflight
 * + bounded re-broadcast (the configured RPC IS Helius). The dedicated Sender endpoint + Jito bundles (anti-sandwich)
 * = a config-driven improvement (HELIUS_SENDER_URL / JITO) — the copy mechanics do not depend on them.
 */
import type { Connection } from '@solana/web3.js';

export async function land(conn: Connection, rawSignedTx: Buffer | Uint8Array): Promise<string> {
  return conn.sendRawTransaction(rawSignedTx, { skipPreflight: true, maxRetries: 3 });
}

/**
 * Poll until a landed tx reaches 'confirmed' (or errors / times out). Used to gate a DEPENDENT follow-up tx: a
 * two-sided open must wait for its token-BUY to settle, else the open lands before the token is in the wallet
 * and fails. Returns true only on a successful (no-err) confirmation. Polls cheaply (getSignatureStatus).
 */
export async function confirmLanded(conn: Connection, signature: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await conn.getSignatureStatus(signature);
    if (value?.err) return false;
    if (value?.confirmationStatus === 'confirmed' || value?.confirmationStatus === 'finalized') return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
