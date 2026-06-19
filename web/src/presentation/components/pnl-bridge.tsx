'use client';

import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { periodDays } from '@/domain/period';
import { toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useMoney } from '@/presentation/hooks/use-money';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { cn, Skeleton, SolMark, toneText } from '@/presentation/ui';

/**
 * The PnL reconciliation — the headline that resolves the app's most confusing duality. The HERO is
 * the wallet's TRUE on-chain SOL result; underneath, one sober line tells the story of the gap:
 *   marked at close (mark-at-close / LPAgent parity)  vs  lost after close (rugs / slippage).
 * The post-close term = wallet − positions: the bleed the per-position view never sees.
 */
export function PnlBridge({ positionsPnl }: { positionsPnl: number }) {
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const period = useUi((s) => s.period);
  const m = useMoney();
  const { data: curve, loading } = useScopedQuery(
    () => api.walletPnlCurve(scope, periodDays(period)),
    [scope, closedVersion, period],
  );

  if (loading && !curve) return <Skeleton className="h-[96px] w-full rounded-lg" />;
  if (!curve) return null;

  const wallet = curve.totalTradingSol;
  const postClose = wallet - positionsPnl;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-[11px] text-faint uppercase tracking-wide">
            Real PnL · on-chain{!curve.complete && ' · indexing…'}
          </p>
          <div
            className={cn(
              'tabular mt-1 inline-flex items-center gap-1.5 font-semibold text-3xl leading-none',
              toneText[toneOf(wallet)],
            )}
          >
            {m.sol(wallet, { signed: true })}
            {m.showGlyph && <SolMark size={18} />}
          </div>
        </div>
        <span
          title="The wallet's TRUE realized SOL. Unlike the per-position 'mark-at-close' figure, it also books the loss from dumping leftover tokens AFTER a close (rugs / slippage). Post-close = wallet − positions."
          className="mt-0.5 grid size-[18px] shrink-0 cursor-help place-items-center rounded-full border border-border text-[11px] text-faint"
          role="img"
          aria-label="How the real PnL is reconciled"
        >
          i
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[13px] text-muted">
        <Frag label="Marked at close" value={positionsPnl} />
        <Frag label="Lost after close" value={postClose} />
      </div>
    </div>
  );
}

/** One side of the reconciliation: a tone dot + label + signed SOL value (no glyph — keeps the line calm). */
function Frag({ label, value }: { label: string; value: number }) {
  const m = useMoney();
  const tone = toneOf(value);
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={cn(
          'size-1.5 rounded-full',
          tone === 'profit' ? 'bg-profit' : tone === 'loss' ? 'bg-loss' : 'bg-faint',
        )}
        aria-hidden="true"
      />
      {label}
      <b className={cn('tabular font-semibold', toneText[tone])}>
        {m.sol(value, { signed: true })}
      </b>
    </span>
  );
}
