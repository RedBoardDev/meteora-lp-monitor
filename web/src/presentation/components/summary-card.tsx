'use client';

import type { NetworthCurvePoint } from '@binsight/shared';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { PERIOD_OPTIONS, type Period, sinceMs } from '@/domain/period';
import { toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useMoney } from '@/presentation/hooks/use-money';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { Badge, Card, cn, Skeleton, SolMark, Stat, TickFlash } from '@/presentation/ui';

/** Days window for the all-time Net Worth curve (sliced client-side per the selected period). */
const ALL_TIME_DAYS = 3650;

/** Short label for the selected period (e.g. "1M") — used in the "Gain (1M)" stat caption. */
function periodLabel(period: Period): string {
  return PERIOD_OPTIONS.find((o) => o.value === period)?.label ?? period.toUpperCase();
}

/** Net Worth at the start of `period` = the first curve point on/after the period floor (the baseline
 *  the gain is measured against). Null when the curve has no point in the window. */
function networthAtStart(points: NetworthCurvePoint[], period: Period, now: number): number | null {
  const floor = sinceMs(period, now);
  if (floor <= 0) return points[0]?.networth ?? null;
  const start = points.find((p) => Date.parse(`${p.date}T00:00:00Z`) >= floor);
  return start?.networth ?? null;
}

export function SummaryCard() {
  const portfolio = usePortfolio((s) => s.portfolio);
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const scopeLoading = usePortfolio((s) => s.scopeLoading);
  const period = useUi((s) => s.period);
  const m = useMoney();
  // The REAL Net Worth curve (on-chain cash + capital deployed in open positions), per UTC day. Fetched
  // all-time and sliced client-side: the period gain and today's evolution are NetWorth deltas off it.
  const { data: curve } = useScopedQuery(
    () => api.networthCurve(scope, ALL_TIME_DAYS),
    [scope, closedVersion],
  );
  if (!portfolio) return <SummarySkeleton />;

  const t = portfolio.totals;
  const pnlTone = toneOf(t.uPnlSol);
  const points = curve?.points ?? [];
  // NOW = the live, on-chain-reconciled net worth (walletTotalSol = idle + open TVL), NOT the curve's
  // last point: today's at-cost reconstruction lags the live tx stream (a fresh deposit hits the cash
  // ledger before its position shows up in the legs), which would briefly show a phantom loss (-31 etc).
  const nwNow = t.walletTotalSol;
  // Yesterday = the last reconstructed curve point STRICTLY before today (the curve's last point IS today).
  const todayStr = new Date(Date.now()).toISOString().slice(0, 10);
  const past = points.filter((p) => p.date < todayStr);
  const nwYesterday = past.length > 0 ? past[past.length - 1]!.networth : null;
  // TODAY = the day-over-day Net Worth evolution (live now − yesterday's close).
  const today = nwYesterday != null ? nwNow - nwYesterday : null;
  // GAIN (period) = NetWorth(now) − NetWorth(start of the selected period). The REAL, on-chain gain.
  const startNw = networthAtStart(points, period, Date.now());
  const gain = startNw != null ? nwNow - startNw : null;

  return (
    <Card
      className={cn('p-6 transition-opacity md:p-7', scopeLoading && 'opacity-60')}
      aria-busy={scopeLoading}
    >
      <div className="flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <span className="font-medium text-faint text-xs uppercase tracking-wider">Net Worth</span>
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
            label="Today"
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
                : 'Net Worth Δ'
            }
          />
          <Stat
            label="Active PnL"
            tone={pnlTone}
            value={<TickFlash value={t.uPnlSol}>{m.sol(t.uPnlSol, { signed: true })}</TickFlash>}
            sub={m.pct(t.uPnlPct)}
          />
          <Stat
            label={`Gain (${periodLabel(period)})`}
            tone={gain != null ? toneOf(gain) : 'neutral'}
            value={gain != null ? m.sol(gain, { signed: true }) : '—'}
            sub="Net Worth Δ"
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
