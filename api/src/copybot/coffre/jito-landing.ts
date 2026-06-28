/**
 * Copy-bot · coffre — land a signed tx via the Jito block engine as a single-tx bundle (anti-sandwich), with a
 * MANDATORY fallback to the normal RPC send so a tx is NEVER dropped if Jito is down/slow. The Jito tip (added by
 * the brain, within the priority cap) is only HONORED on the bundle path — on the fallback it is simply not
 * prioritized (the tx still lands by its own signature).
 *
 * No DLMM SDK (firewall F3-safe): just an HTTP POST + the existing `land()` fallback.
 */
import type { Connection } from '@solana/web3.js';
import { land } from './landing';

type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Submit `rawSignedTx` as a Jito bundle; return its `signature` on acceptance. On ANY error (network, non-2xx,
 * timeout) fall back to a normal RPC send so the tx still lands. The caller already knows the signed tx's signature.
 */
export async function landViaJito(
  conn: Connection,
  bundleUrl: string,
  rawSignedTx: Buffer | Uint8Array,
  signature: string,
  fetchFn: HttpFetch = fetch as unknown as HttpFetch,
): Promise<string> {
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[Buffer.from(rawSignedTx).toString('base64')]] });
    const res = await fetchFn(`${bundleUrl}/api/v1/bundles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (!res.ok) throw new Error(`jito sendBundle HTTP ${res.status}`);
    await res.json(); // bundle id — accepted; the tx lands by its own signature
    return signature;
  } catch {
    return land(conn, rawSignedTx); // never drop the tx: normal RPC send (tip not honored, but it lands)
  }
}
