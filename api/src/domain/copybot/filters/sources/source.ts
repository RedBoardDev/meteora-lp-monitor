/**
 * Copy-bot · filter data SOURCES — the normalized per-token snapshot + the provider port. The PURE resolver
 * (`./resolve`) reads through this port; concrete adapters (`./jupiter-token/`) implement it. ONE snapshot
 * feeds many filters (spec `docs/spec/19-entry-filter-engine.md` §5). All filter data lives under `filters/`.
 */

/**
 * Normalized per-token snapshot — the union of fields our filters need, mapped from a source (Jupiter v2).
 * `null` = the source did not provide that field (⇒ the dependent enabled filter will skip as `*_unavailable`).
 */
export interface TokenSnapshot {
  organicScore: number | null;
  holders: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPercent: number | null;
  firstPoolCreatedAtMs: number | null;
  // Authority signals — free in the same Jupiter call; consumed by the (later) `authorityAntiRug` brick.
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  topHoldersPercent: number | null;
}

/** Port: fetch a token's snapshot. Returns null on miss/timeout/error (NEVER throws → enabled filters skip). */
export type TokenSnapshotProvider = (mint: string) => Promise<TokenSnapshot | null>;
