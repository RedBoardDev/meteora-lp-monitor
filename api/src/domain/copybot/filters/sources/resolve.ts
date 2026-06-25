/**
 * Copy-bot · PURE orchestration of the filters' external data: ONE fetch per NEEDED source (grouped, not
 * per-metric), cache-first, bounded by a hard timeout. A miss/timeout ⇒ that source's fields are omitted (the
 * enabled filters then skip). Returns ONLY external fields — the caller merges local (`openTokenMints`) +
 * leader-shape (`priceRangePercent`). Providers are injected ⇒ no direct I/O here. Spec: `19` §5.
 */
import type { TtlCache } from '../../ttl-cache';
import type { DataSource, FilterContext } from '../filter';
import { snapshotToContext } from './snapshot';
import type { TokenSnapshot, TokenSnapshotProvider } from './source';

const JUPITER_TOKEN: DataSource = 'jupiter-token';

/** Concrete providers + caches the resolver orchestrates (one entry per external source). */
export interface ResolveDeps {
  jupiterToken: TokenSnapshotProvider;
  snapshotCache: TtlCache<TokenSnapshot>;
}

/** Resolve the externally-sourced `FilterContext` fields for `mint`, given the sources the config needs. */
export async function resolveFilterContext(
  mint: string | null,
  sources: ReadonlySet<DataSource>,
  deps: ResolveDeps,
  opts: { nowMs: number; timeoutMs: number },
): Promise<Partial<FilterContext>> {
  if (!mint || !sources.has(JUPITER_TOKEN)) return {};
  const cached = deps.snapshotCache.get(mint, opts.nowMs);
  const snapshot = cached ?? (await settleWithin(deps.jupiterToken(mint), opts.timeoutMs));
  if (!snapshot) return {};
  if (!cached) deps.snapshotCache.set(mint, snapshot, opts.nowMs);
  return snapshotToContext(snapshot, opts.nowMs);
}

/** Resolve to `null` on timeout OR rejection — never throws (keeps filters off the open's critical path). */
function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
