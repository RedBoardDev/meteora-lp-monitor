import type { GetProgramAccountsFilter } from '@solana/web3.js';

/**
 * Pure request-builder + response-parser for Helius `getProgramAccountsV2` — the 1-credit, cursor-paged
 * replacement for the legacy 10-credit `getProgramAccounts` (see the Helius credit model in
 * docs/research/near-zero-watcher-PLAN.md). web3.js's `Connection` exposes no `getProgramAccountsV2`
 * method, so the gateway issues it as a RAW JSON-RPC call through the SAME rate-limited Connection (so
 * the credit meter still sees method `'getProgramAccountsV2'` → 1 credit). This module keeps that call's
 * params/response shape PURE so it's unit-tested with no network. No I/O here.
 *
 * Request:  params = [programId, { encoding, filters, dataSlice, commitment, limit, paginationKey?,
 *                                   changedSinceSlot? }]
 * Response: { result: { accounts: [{ pubkey, account }], paginationKey: string | null } }
 * (verified against https://www.helius.dev/docs/api-reference/rpc/http/getprogramaccountsv2)
 */

/** Helius caps a getProgramAccountsV2 page at 10,000 accounts; one credit per page regardless of size. */
export const GPA_V2_PAGE_LIMIT = 10_000;

/**
 * Issues a raw JSON-RPC method through the metered Connection and resolves the FULL JSON-RPC envelope
 * ({ result } | { error }) — exactly what web3.js's internal `_rpcRequest` returns. Injected so the
 * gateway is testable with a spy and the production path stays on the credit-metered fetch middleware.
 */
export type RawRpc = (method: string, params: unknown[]) => Promise<unknown>;

export interface GpaV2Config {
  filters: GetProgramAccountsFilter[];
  /** Bytes to return per account; `{ offset: 0, length: 0 }` = pubkeys only (discovery is pubkeys-only). */
  dataSlice: { offset: number; length: number };
  commitment: string;
  /** Max accounts per page (1–{@link GPA_V2_PAGE_LIMIT}). */
  limit: number;
  /** Cursor from the previous page; omit/null for the first page. */
  paginationKey?: string | null;
  /**
   * Helius incremental filter: only accounts modified since this slot. Plumbed for a future incremental
   * discovery path; the engine currently issues a FULL discovery (this omitted) so the result set is
   * byte-identical to the legacy getProgramAccounts (no-miss: an unchanged-but-still-open position is
   * never dropped). See the deferral note in onchain-gateway.discover().
   */
  changedSinceSlot?: number;
}

/** Build the `params` array for a getProgramAccountsV2 call (base64, pubkeys-only when dataSlice={0,0}). */
export function buildGpaV2Params(programId: string, cfg: GpaV2Config): unknown[] {
  const config: Record<string, unknown> = {
    encoding: 'base64',
    filters: cfg.filters,
    dataSlice: cfg.dataSlice,
    commitment: cfg.commitment,
    limit: cfg.limit,
  };
  if (cfg.paginationKey != null) config.paginationKey = cfg.paginationKey;
  if (cfg.changedSinceSlot !== undefined) config.changedSinceSlot = cfg.changedSinceSlot;
  return [programId, config];
}

/** One parsed page: the account pubkeys + the next cursor (null = last page). */
export interface GpaV2Page {
  pubkeys: string[];
  paginationKey: string | null;
}

interface GpaV2Envelope {
  result?: {
    accounts?: { pubkey: string }[];
    paginationKey?: string | null;
  };
  error?: { code?: number; message?: string };
}

/** Parse a getProgramAccountsV2 JSON-RPC envelope → pubkeys + next cursor. Throws on a JSON-RPC error so
 *  a failed discovery surfaces (never silently returns an empty/partial set — a no-miss guard). */
export function parseGpaV2Response(envelope: unknown): GpaV2Page {
  const env = envelope as GpaV2Envelope | null | undefined;
  if (env?.error) {
    throw new Error(
      `getProgramAccountsV2 failed: ${env.error.message ?? `code ${env.error.code}`}`,
    );
  }
  const result = env?.result;
  if (!result) throw new Error('getProgramAccountsV2: malformed response (no result)');
  const pubkeys = (result.accounts ?? []).map((a) => a.pubkey);
  return { pubkeys, paginationKey: result.paginationKey ?? null };
}
