'use client';

import type { Stats } from '@meteora/shared';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { fmtDuration } from '@/domain/format';
import { sinceMs } from '@/domain/period';
import { toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import {
  Card,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  IconTrophy,
  Skeleton,
  SolAmount,
  Stat,
  toneText,
} from '@/presentation/ui';
import { PnlBridge } from './pnl-bridge';

export function PerformanceCard() {
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const period = useUi((s) => s.period);
  const { data, loading, stale } = useScopedQuery(
    () => api.stats(scope, sinceMs(period, Date.now())),
    [scope, closedVersion, period],
  );

  return (
    <Card className={cn('transition-opacity', stale && 'opacity-60')} aria-busy={stale}>
      <CardHeader>
        <CardTitle>Performance</CardTitle>
        {data && <span className="tabular text-faint text-xs">{data.closedCount} trades</span>}
      </CardHeader>
      <div className="p-5">
        {loading && !data ? (
          <StatsSkeleton />
        ) : !data || data.closedCount === 0 ? (
          <EmptyState
            icon={<IconTrophy size={18} />}
            title="No closed trades yet"
            hint="Your realized performance will appear here."
          />
        ) : (
          <PerformanceBody stats={data} />
        )}
      </div>
    </Card>
  );
}

function PerformanceBody({ stats }: { stats: Stats }) {
  return (
    <div className="flex flex-col gap-6">
      <PnlBridge positionsPnl={stats.totalPnlSol} />
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
        <Stat
          label="Win rate"
          value={`${stats.winRate.toFixed(0)}%`}
          sub={`${stats.wins}W · ${stats.losses}L`}
        />
        <Stat
          label="Profit factor"
          tone={stats.profitFactor === 0 ? 'neutral' : stats.profitFactor >= 1 ? 'profit' : 'loss'}
          value={stats.profitFactor > 0 ? stats.profitFactor.toFixed(2) : '—'}
          sub="gross W / L"
        />
        <Stat
          label="Expected value"
          tone={toneOf(stats.expectedValueSol)}
          value={<SolAmount n={stats.expectedValueSol} signed />}
          sub="per trade"
        />
        <Stat label="Avg invested" value={<SolAmount n={stats.avgInvestedSol} />} sub="per trade" />
        <Stat
          label="Avg / month"
          tone={toneOf(stats.avgMonthlyProfitSol)}
          value={<SolAmount n={stats.avgMonthlyProfitSol} signed />}
        />
        <Stat label="Avg hold" value={fmtDuration(stats.avgDurationSeconds)} />
        <Stat label="Fees earned" value={<SolAmount n={stats.totalFeesSol} />} sub="all-time" />
        <Stat label="Volume" value={<SolAmount n={stats.totalVolumeSol} />} sub="deposited" />
      </div>

      {stats.byPair.length > 0 && <ByPair pairs={stats.byPair} />}
    </div>
  );
}

function ByPair({ pairs }: { pairs: Stats['byPair'] }) {
  const top = pairs.filter((p) => p.pnlSol > 0).slice(0, 4);
  const worst = pairs
    .filter((p) => p.pnlSol < 0)
    .slice(-4)
    .reverse();
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 border-border border-t pt-5 sm:grid-cols-2">
      <PairColumn title="Top pairs" pairs={top} />
      <PairColumn title="Worst pairs" pairs={worst} />
    </div>
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

function StatsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}
