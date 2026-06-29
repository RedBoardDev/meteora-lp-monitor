import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The recurring RPC "code paths" we attribute credit spend to. A caller wraps its outermost RPC entry
 * point in `withCodePath(tag, fn)`; every RPC issued underneath reads the tag via `currentCodePath()`
 * (set in the rate-limiter / gateways) so the CreditMeter can answer "WHICH path burned the credits".
 * The tags are stable identifiers (not prose) — keep them as-is.
 */
export type CodePath =
  | 'snapshot' // live open-position read/valuation
  | 'ingest' // signatures → getTransaction history ingest
  | 'realized' // realized-PnL FIFO close path
  | 'discovery' // new-wallet onboarding / pool discovery
  | 'strategy' // strategy resolution backfill
  | 'reconcile' // on-chain reconcile / close-confirm
  | 'enhanced' // Helius Enhanced Transactions API
  | 'metadata' // DAS token-metadata reads
  | 'unknown'; // unattributed (default when no caller tag is set)

const storage = new AsyncLocalStorage<CodePath>();

/** Run `fn` with `tag` as the active code path; nested calls override the parent tag for their subtree. */
export function withCodePath<T>(tag: CodePath, fn: () => T): T {
  return storage.run(tag, fn);
}

/** The active code path for the current async context, or 'unknown' when no caller set one. */
export function currentCodePath(): CodePath {
  return storage.getStore() ?? 'unknown';
}
