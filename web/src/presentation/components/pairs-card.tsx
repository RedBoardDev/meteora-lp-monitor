'use client';

import type { Stats } from '@binsight/shared';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { sinceMs } from '@/domain/period';
import { toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { Card, CardHeader, CardTitle, cn, Skeleton, SolAmount, toneText } from '@/presentation/ui';

/** Best & worst pairs — a standalone module placed under the chart. Clicking a pair filters History. */
export function PairsCard() {
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const period = useUi((s) => s.period);
  const { data, loading, stale } = useScopedQuery(
    () => api.stats(scope, sinceMs(period, Date.now())),
    [scope, closedVersion, period],
  );

  if (loading && !data) return <Skeleton className="h-44 w-full rounded-xl" />;
  if (!data || data.byPair.length === 0) return null;

  const top = data.byPair.filter((p) => p.pnlSol > 0).slice(0, 5);
  const worst = data.byPair
    .filter((p) => p.pnlSol < 0)
    .slice(-5)
    .reverse();

  return (
    <Card className={cn('transition-opacity', stale && 'opacity-60')} aria-busy={stale}>
      <CardHeader>
        <CardTitle>Best &amp; worst pairs</CardTitle>
      </CardHeader>
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 p-5 sm:grid-cols-2">
        <PairColumn title="Top pairs" pairs={top} />
        <PairColumn title="Worst pairs" pairs={worst} />
      </div>
    </Card>
  );
}

function PairColumn({ title, pairs }: { title: string; pairs: Stats['byPair'] }) {
  const filterByToken = useUi((s) => s.filterByToken);
  return (
    <div>
      <p className="mb-2 font-medium text-faint text-xs uppercase tracking-wide">{title}</p>
      <div className="flex flex-col gap-0.5">
        {pairs.length === 0 && <p className="text-faint text-sm">—</p>}
        {pairs.map((p) => {
          const [x = '', y = ''] = p.pair.split('/');
          const token = y === 'SOL' ? x : p.pair;
          return (
            <button
              type="button"
              key={p.pair}
              onClick={() => filterByToken(token)}
              title={`Filter history by ${token}`}
              className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-hover"
            >
              <span className="flex items-center gap-2 text-text">
                {p.pair}
                <span className="tabular text-faint text-xs">×{p.count}</span>
              </span>
              <span className={cn('tabular font-medium', toneText[toneOf(p.pnlSol)])}>
                <SolAmount n={p.pnlSol} signed />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
