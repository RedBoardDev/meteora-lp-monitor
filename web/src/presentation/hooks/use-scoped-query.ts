'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type QueryResult<T> = {
  data: T | null;
  loading: boolean;
  /** Re-fetching while previous data is still shown — for a subtle "refreshing" dim, not a skeleton. */
  stale: boolean;
  error: boolean;
  refetch: () => void;
};

/** Small client-side REST query: re-runs whenever `deps` change, ignores stale responses. */
export function useScopedQuery<T>(fetcher: () => Promise<T>, deps: unknown[]): QueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  const depsKey = JSON.stringify(deps);
  const prevDepsKey = useRef(depsKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller; tick forces a manual refetch.
  useEffect(() => {
    let alive = true;
    // On a SCOPE change (deps changed, not a manual refetch) drop the previous scope's data, so a slow
    // or failing fetch never shows stale data under the new scope's header. A tick-only refetch keeps
    // it (the "refreshing" dim).
    if (prevDepsKey.current !== depsKey) {
      prevDepsKey.current = depsKey;
      setData(null);
    }
    setLoading(true);
    setError(false);
    fetcher()
      .then((d) => {
        if (alive) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [...deps, tick]);

  return { data, loading, stale: loading && data != null, error, refetch };
}
