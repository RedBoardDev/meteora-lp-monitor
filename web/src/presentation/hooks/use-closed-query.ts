'use client';

import { useEffect, useState } from 'react';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { ClosedPositionEntity } from '@/domain/position';
import { api, type ClosedQuery } from '@/infrastructure/api/client';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { SEARCH_DEBOUNCE_MS } from '@/presentation/ui/timing';

const CLOSED_PAGE_SIZE = 10;

export const CLOSED_RESULTS = [
  { label: 'All', value: 'all' as const },
  { label: 'Wins', value: 'win' as const },
  { label: 'Losses', value: 'loss' as const },
];

export const CLOSED_SORTS = [
  { label: 'Recent', value: 'recent' as const },
  { label: 'PnL', value: 'pnl' as const },
  { label: 'Fees', value: 'fees' as const },
  { label: 'Held', value: 'duration' as const },
];

/**
 * Headless closed-positions query — owns scope/page/search (debounced)/result/sort/dir, the scoped
 * fetch, the derived rows/total/pages and the CSV export of the current filter. Shared verbatim by
 * the desktop {@link ClosedPositionsTable} and the mobile history view so the filtering logic lives
 * in exactly one place.
 */
export function useClosedQuery() {
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const historyQuery = useUi((s) => s.historyQuery);
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [result, setResult] = useState<NonNullable<ClosedQuery['result']>>('all');
  const [sort, setSort] = useState<NonNullable<ClosedQuery['sort']>>('recent');
  const [dir, setDir] = useState<NonNullable<ClosedQuery['dir']>>('desc');

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [qInput]);

  // An external token filter (clicking a Stats pair → filterByToken) drives the search box.
  useEffect(() => {
    if (historyQuery) setQInput(historyQuery);
  }, [historyQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset to page 1 on scope/filter change.
  useEffect(() => setPage(1), [scope, q, result, sort, dir]);

  const { data, loading, stale, error, refetch } = useScopedQuery(
    () => api.closed(scope, page, CLOSED_PAGE_SIZE, { q, result, sort, dir }),
    [scope, page, closedVersion, q, result, sort, dir],
  );

  const rows = (data?.rows ?? []).map((r) => new ClosedPositionEntity(r));
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / CLOSED_PAGE_SIZE));

  // CSV of the CURRENT filter (cookie-authed download, so a plain <a> carries the session).
  function exportCsv() {
    const params = new URLSearchParams({ wallet: scope, sort, dir });
    if (q) params.set('q', q);
    if (result !== 'all') params.set('result', result);
    const a = document.createElement('a');
    a.href = `/api/positions/closed.csv?${params.toString()}`;
    a.download = 'meteora-closed-positions.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return {
    scope,
    hasData: data != null,
    qInput,
    setQInput,
    q,
    result,
    setResult,
    sort,
    setSort,
    dir,
    setDir,
    page,
    setPage,
    rows,
    total,
    pages,
    loading,
    stale,
    error,
    refetch,
    exportCsv,
  };
}
