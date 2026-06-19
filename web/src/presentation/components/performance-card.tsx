'use client';

import type { Stats } from '@binsight/shared';
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
