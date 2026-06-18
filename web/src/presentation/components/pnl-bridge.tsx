'use client';

import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { periodDays } from '@/domain/period';
import { type Tone, toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useMoney } from '@/presentation/hooks/use-money';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { cn, Skeleton, SolMark, toneText } from '@/presentation/ui';

/**
 * The PnL reconciliation bridge — the headline that resolves the app's most confusing duality:
 *   Positions PnL  →  (what leaked after closing)  →  Wallet PnL
 * Position PnL is mark-at-close (LPAgent parity); Wallet PnL is the TRUE on-chain SOL cash-flow, which
 * also books the loss from dumping leftover tokens AFTER a close (rugs / slippage). The middle term is
 * exactly that gap (wallet − positions) — the "post-close bleed", the actionable insight for an LP.
 */
export function PnlBridge({ positionsPnl }: { positionsPnl: number }) {
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const period = useUi((s) => s.period);
  const { data: curve, loading } = useScopedQuery(
    () => api.walletPnlCurve(scope, periodDays(period)),
    [scope, closedVersion, period],
  );

  if (loading && !curve) return <Skeleton className="h-[68px] w-full rounded-lg" />;
  if (!curve) return null;

  const wallet = curve.totalTradingSol;
  const postClose = wallet - positionsPnl;

  return (
    <div className="rounded-lg border border-border bg-bg-elevated/60 p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-1">
        <Node
          label="Positions"
          value={positionsPnl}
          sub="mark-at-close"
          tip="Sum of each closed position's PnL at its close — the LPAgent-style, in-position result."
        />
        <Connector tone={toneOf(postClose)} />
        <Node
          label="Post-close"
          value={postClose}
          sub="rugs · slippage"
          tip="What leaked AFTER closing — selling the leftover token for less than its close value. The bleed the per-position view never sees."
          dim
        />
        <Connector tone={toneOf(wallet)} />
        <Node
          label="Wallet"
          value={wallet}
          sub="true on-chain SOL"
          tip={`The wallet's real realized SOL${curve.complete ? '' : ' (still indexing…)'} — every lamport reconciled on-chain.`}
          strong
        />
      </div>
    </div>
  );
}

function Node({
  label,
  value,
  sub,
  tip,
  dim = false,
  strong = false,
}: {
  label: string;
  value: number;
  sub: string;
  tip: string;
  dim?: boolean;
  strong?: boolean;
}) {
  const m = useMoney();
  const tone: Tone = toneOf(value);
  return (
    <div
      title={tip}
      className={cn(
        'flex flex-1 cursor-help flex-col gap-0.5 rounded-md px-3 py-1.5',
        strong && 'bg-surface/70',
      )}
    >
      <span className="font-medium text-[11px] text-faint uppercase tracking-wide">{label}</span>
      <span
        className={cn(
          'tabular inline-flex items-center gap-1 font-semibold leading-none',
          strong ? 'text-xl' : 'text-lg',
          dim ? 'text-muted' : toneText[tone],
        )}
      >
        {m.sol(value, { signed: true })}
        {m.showGlyph && <SolMark size={strong ? 15 : 13} />}
      </span>
      <span className="text-[11px] text-faint">{sub}</span>
    </div>
  );
}

/** The →/↓ link between two bridge nodes (horizontal on desktop, vertical on mobile). */
function Connector({ tone }: { tone: Tone }) {
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center px-1 text-faint', toneText[tone])}
      aria-hidden="true"
    >
      <span className="hidden sm:inline">→</span>
      <span className="sm:hidden">↓</span>
    </div>
  );
}
