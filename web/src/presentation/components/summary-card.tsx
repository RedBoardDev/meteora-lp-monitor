'use client';

import { usePortfolio } from '@/application/stores/portfolio-store';
import { toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useMoney } from '@/presentation/hooks/use-money';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { Badge, Card, cn, Skeleton, SolMark, Stat, TickFlash } from '@/presentation/ui';

/** Days window for the all-time on-chain PnL headline (the rolling daily rollup keeps this cheap). */
const ALL_TIME_DAYS = 3650;

export function SummaryCard() {
  const portfolio = usePortfolio((s) => s.portfolio);
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const scopeLoading = usePortfolio((s) => s.scopeLoading);
  const m = useMoney();
  // Lightweight: only today's realized PnL is read here (since=0 — todayPnlSol is computed from local
  // midnight server-side regardless of the window). The heavier Stats grid still lives in the Stats tab.
  const { data: stats } = useScopedQuery(() => api.stats(scope, 0), [scope, closedVersion]);
  // The wallet's TRUE all-time on-chain realized PnL — the headline truth (also reconciled in Stats).
  const { data: curve } = useScopedQuery(
    () => api.walletPnlCurve(scope, ALL_TIME_DAYS),
    [scope, closedVersion],
  );
  if (!portfolio) return <SummarySkeleton />;

  const t = portfolio.totals;
  const pnlTone = toneOf(t.uPnlSol);
  const today = stats?.todayPnlSol ?? null;
  const realPnl = curve?.totalTradingSol ?? null;

  return (
    <Card
      className={cn('p-6 transition-opacity md:p-7', scopeLoading && 'opacity-60')}
      aria-busy={scopeLoading}
    >
      <div className="flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <span className="font-medium text-faint text-xs uppercase tracking-wider">
            Wallet total
          </span>
          <TickFlash value={t.walletTotalSol} className="flex items-center gap-2.5">
            <span className="tabular font-semibold text-4xl text-text leading-none tracking-tight">
              {m.hero(t.walletTotalSol)}
            </span>
            {m.showGlyph && <SolMark size={22} />}
          </TickFlash>
          <div className="tabular flex items-center gap-2 text-muted text-sm">
            <span>{m.sol(t.tvlSol)} LP</span>
            <span className="text-faint">·</span>
            <span>{m.sol(t.idleSol)} idle</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4 sm:gap-x-10">
          <Stat
            label="Realized today"
            tone={today != null ? toneOf(today) : 'neutral'}
            value={
              today != null ? (
                <TickFlash value={today}>{m.sol(today, { signed: true })}</TickFlash>
              ) : (
                '—'
              )
            }
            sub={
              today != null && t.walletTotalSol > 0
                ? m.pct((today / t.walletTotalSol) * 100)
                : undefined
            }
          />
          <Stat
            label="Active PnL"
            tone={pnlTone}
            value={<TickFlash value={t.uPnlSol}>{m.sol(t.uPnlSol, { signed: true })}</TickFlash>}
            sub={m.pct(t.uPnlPct)}
          />
          <Stat
            label="Real PnL"
            tone={realPnl != null ? toneOf(realPnl) : 'neutral'}
            value={realPnl != null ? m.sol(realPnl, { signed: true }) : '—'}
            sub="on-chain"
          />
          <Stat
            label="Open"
            value={t.openCount}
            sub={
              <span className="flex gap-1.5">
                <Badge tone="in">{t.inRangeCount} in</Badge>
                <Badge tone="out">{t.outOfRangeCount} out</Badge>
              </span>
            }
          />
        </div>
      </div>
    </Card>
  );
}

function SummarySkeleton() {
  return (
    <Card className="p-6 md:p-7">
      <div className="flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4 sm:gap-x-10">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
