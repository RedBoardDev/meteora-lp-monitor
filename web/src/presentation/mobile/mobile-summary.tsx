'use client';

import type { ReactNode } from 'react';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { type Tone, toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useMoney } from '@/presentation/hooks/use-money';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { Badge, Card, cn, Skeleton, SolMark, toneText } from '@/presentation/ui';

const pctOf = (value: number, basis: number) => (basis > 0 ? (value / basis) * 100 : 0);

/**
 * Compact global mobile header (rendered on every tab): Net Worth hero + Today only, to stay small on
 * a phone. The richer metrics live in {@link MobilePortfolioStats} on the Positions tab. Its own
 * component (not the desktop {@link SummaryCard}) so the desktop header stays untouched.
 */
export function MobileSummary() {
  const portfolio = usePortfolio((s) => s.portfolio);
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const m = useMoney();
  // Today's realized PnL is the backend's single source of truth (same value the macOS/iOS apps show).
  const { data: stats } = useScopedQuery(() => api.stats(scope), [scope, closedVersion]);

  if (!portfolio) return <Skeleton className="h-[5.5rem] w-full rounded-xl" />;

  const t = portfolio.totals;
  const today = stats?.todayPnlSol ?? null;
  const todayTone = today != null ? toneOf(today) : 'neutral';

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-[11px] text-faint uppercase tracking-wider">
            Net Worth
          </div>
          <div className="tabular mt-1 flex items-center gap-2 font-semibold text-3xl text-text leading-none tracking-tight">
            {m.hero(t.walletTotalSol)}
            {m.showGlyph && <SolMark size={18} />}
          </div>
          <div className="tabular mt-1.5 text-faint text-xs">
            {m.sol(t.tvlSol)} LP · {m.sol(t.idleSol)} idle
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-medium text-[11px] text-faint uppercase tracking-wider">Today</div>
          <div
            className={cn(
              'tabular mt-1 font-semibold text-lg leading-none',
              todayTone === 'neutral' ? 'text-text' : toneText[todayTone],
            )}
          >
            {today != null ? m.sol(today, { signed: true }) : '—'}
          </div>
          {today != null && (
            <div
              className={cn(
                'tabular mt-1 text-xs',
                todayTone === 'neutral' ? 'text-faint' : toneText[todayTone],
              )}
            >
              {m.pct(pctOf(today, t.walletTotalSol))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Secondary portfolio metrics box — Active PnL · Open · Fees · TVL. Shown on the Positions tab only,
 *  keeping the global {@link MobileSummary} header compact. */
export function MobilePortfolioStats() {
  const portfolio = usePortfolio((s) => s.portfolio);
  const m = useMoney();
  if (!portfolio) return null;

  const t = portfolio.totals;
  const feesTotal = t.claimedFeesSol + t.unclaimedFeesSol;

  return (
    <Card className="grid grid-cols-2 gap-x-6 gap-y-4 p-4">
      <SummaryStat
        label="Active PnL"
        tone={toneOf(t.uPnlSol)}
        value={m.sol(t.uPnlSol, { signed: true })}
        sub={m.pct(t.uPnlPct)}
      />
      <SummaryStat
        label="Open"
        value={t.openCount}
        sub={
          <span className="flex gap-1.5">
            <Badge tone="in">{t.inRangeCount} in</Badge>
            <Badge tone="out">{t.outOfRangeCount} out</Badge>
          </span>
        }
      />
      <SummaryStat
        label="Fees"
        value={m.sol(feesTotal)}
        sub={`${m.pct(pctOf(feesTotal, t.tvlSol))} of TVL`}
      />
      <SummaryStat label="TVL" value={m.sol(t.tvlSol)} />
    </Card>
  );
}

function SummaryStat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0">
      <div className="text-faint text-xs">{label}</div>
      <div
        className={cn(
          'tabular mt-1 font-semibold text-sm',
          tone === 'neutral' ? 'text-text' : toneText[tone],
        )}
      >
        {value}
      </div>
      {sub && <div className="tabular mt-0.5 text-faint text-xs">{sub}</div>}
    </div>
  );
}
