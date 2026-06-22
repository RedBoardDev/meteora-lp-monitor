'use client';

import type { ReactNode } from 'react';
import { useUi } from '@/application/stores/ui-store';
import { fmtDuration, fmtRelative } from '@/domain/format';
import type { ClosedPositionEntity, OpenPositionEntity, Tone } from '@/domain/position';
import { TokenPair } from '@/presentation/components/position-row';
import { useMoney } from '@/presentation/hooks/use-money';
import { Badge, cn, RangeBar, toneText } from '@/presentation/ui';

/**
 * Mobile position cards — the vertical, native-feeling replacement for the desktop table rows
 * (modelled on the iOS `PositionCard`). The whole card is the tap target; it opens the detail
 * bottom sheet via `useUi().select`. Reuses the shared atoms (`TokenPair`, `RangeBar`, `useMoney`).
 */

function CardShell({ onOpen, children }: { onOpen: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-2.5 rounded-xl border border-border bg-surface p-3 text-left shadow-card transition-colors active:bg-hover"
    >
      {children}
    </button>
  );
}

/** PnL stacked SOL-over-percent, right-aligned and toned — the card's headline figure. */
function PnlBlock({ sol, pct, tone }: { sol: number; pct: number; tone: Tone }) {
  const m = useMoney();
  return (
    <div className={cn('tabular shrink-0 text-right text-sm leading-tight', toneText[tone])}>
      <div>{m.sol(sol, { signed: true })}</div>
      <div className="text-xs">{m.pct(pct)}</div>
    </div>
  );
}

export function OpenPositionCard({ p, now }: { p: OpenPositionEntity; now: number }) {
  const select = useUi((s) => s.select);
  const m = useMoney();
  const age = p.raw.openedAt ? fmtDuration((now - p.raw.openedAt) / 1000) : '—';
  return (
    <CardShell onOpen={() => select({ address: p.address, pair: p.pair, open: true })}>
      {/* Row 1 — pair + status/strategy badges (left) · PnL (right), like the iOS card. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TokenPair
            pair={p.pair}
            iconX={p.raw.tokenXIcon}
            iconY={p.raw.tokenYIcon}
            strategy={null}
          />
          <Badge tone={p.inRange ? 'in' : 'out'} className="shrink-0">
            {p.inRange ? 'IN' : 'OUT'}
          </Badge>
          {p.strategy && <Badge className="shrink-0">{p.strategy}</Badge>}
        </div>
        <PnlBlock sol={p.pnlSol} pct={p.pnlPct} tone={p.tone} />
      </div>
      {/* Row 2 — size·age over fees (left) · range bar at a fixed width (right). */}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 leading-snug">
          <div className="tabular text-muted text-xs">
            Size {m.sol(p.sizeSol)} · {age}
          </div>
          <div className="tabular text-muted text-xs">
            Fees {m.sol(p.totalFeesSol)} · {p.sizeSol > 0 ? `${p.feeYieldPct.toFixed(2)}%` : '—'}
          </div>
        </div>
        <div className="w-28 shrink-0">
          <RangeBar placement={p.rangePlacement} inRange={p.inRange} />
        </div>
      </div>
    </CardShell>
  );
}

export function ClosedPositionCard({ p, now }: { p: ClosedPositionEntity; now: number }) {
  const select = useUi((s) => s.select);
  const m = useMoney();
  return (
    <CardShell
      onOpen={() => select({ address: p.address, pair: p.pair, open: false, closed: p.raw })}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <TokenPair
            pair={p.pair}
            iconX={p.raw.tokenXIcon}
            iconY={p.raw.tokenYIcon}
            strategy={p.strategy}
          />
        </div>
        <PnlBlock sol={p.pnlSol} pct={p.pnlPct} tone={p.tone} />
      </div>
      <div className="tabular text-muted text-xs">
        Fees {m.sol(p.feesSol)} · invested {m.sol(p.raw.depositSol)} ·{' '}
        {fmtRelative(p.closedAt, now)}
      </div>
    </CardShell>
  );
}
