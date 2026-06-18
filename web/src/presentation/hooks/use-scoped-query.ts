'use client';

import { useCallback, useEffect, useState } from 'react';

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller; tick forces a manual refetch.
  useEffect(() => {
    let alive = true;
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
