'use client';

import { useState } from 'react';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { fmtDuration, rangeLabel } from '@/domain/format';
import type { OpenPositionEntity } from '@/domain/position';
import { useMoney } from '@/presentation/hooks/use-money';
import {
  Badge,
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  IconLayers,
  RangeBar,
} from '@/presentation/ui';
import { Pagination } from './pagination';
import { PnlCell, PoolActions, RowHeader, RowShell, RowSkeleton, TokenPair } from './position-row';

const OPEN_COLS = '1.7fr 0.8fr 1fr 1.3fr 1fr 1.2fr';
// Open positions are usually a handful — only paginate once a wallet runs a LOT of them at once.
const OPEN_PAGE_SIZE = 100;

export function OpenPositionsTable() {
  const portfolio = usePortfolio((s) => s.portfolio);
  const [openChart, setOpenChart] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  if (!portfolio) return <ListSkeleton />;

  const rows = portfolio.openByValue;
  const pages = Math.max(1, Math.ceil(rows.length / OPEN_PAGE_SIZE));
  const safePage = Math.min(page, pages); // clamp if the live set shrank under us
  const visible = rows.slice((safePage - 1) * OPEN_PAGE_SIZE, safePage * OPEN_PAGE_SIZE);
  const now = Date.now();
  const toggleChart = (addr: string) => setOpenChart((c) => (c === addr ? null : addr));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open positions</CardTitle>
        <span className="tabular text-faint text-xs">{rows.length}</span>
      </CardHeader>
      {rows.length === 0 ? (
        <EmptyState
          icon={<IconLayers size={18} />}
          title="No open positions"
          hint="Active Meteora LP positions appear here live."
        />
      ) : (
        <div className="overflow-x-auto">
          <RowHeader gridCols={OPEN_COLS}>
            <span>Pair</span>
            <span>Age</span>
            <span>Value</span>
            <span title="Claimed · unclaimed">Fees</span>
            <span>uPnL</span>
            <span className="text-right">Range</span>
          </RowHeader>
          <div className="divide-y divide-border">
            {visible.map((p) => (
              <OpenRow
                key={p.address}
                p={p}
                now={now}
                chartOpen={openChart === p.address}
                onToggleChart={() => toggleChart(p.address)}
              />
            ))}
          </div>
          <Pagination
            page={safePage}
            pages={pages}
            onPrev={() => setPage((p) => p - 1)}
            onNext={() => setPage((p) => p + 1)}
          />
        </div>
      )}
    </Card>
  );
}

function OpenRow({
  p,
  now,
  chartOpen,
  onToggleChart,
}: {
  p: OpenPositionEntity;
  now: number;
  chartOpen: boolean;
  onToggleChart: () => void;
}) {
  const select = useUi((s) => s.select);
  const m = useMoney();
  const age = p.raw.openedAt ? fmtDuration((now - p.raw.openedAt) / 1000) : '—';
  return (
    <RowShell
      gridCols={OPEN_COLS}
      chart={{
        positionAddress: p.address,
        poolAddress: p.raw.poolAddress,
        tokenX: p.raw.tokenX,
        tokenMint: p.raw.tokenXMint,
        minPrice: p.raw.minPrice,
        maxPrice: p.raw.maxPrice,
        rangeStatus: p.raw.rangeStatus,
        openedAt: p.raw.openedAt,
        closedAt: null,
      }}
      chartOpen={chartOpen}
      onToggleChart={onToggleChart}
      onOpen={() => select({ address: p.address, pair: p.pair, open: true })}
      cols={
        <>
          <TokenPair
            pair={p.pair}
            iconX={p.raw.tokenXIcon}
            iconY={p.raw.tokenYIcon}
            strategy={p.strategy}
            actions={<PoolActions poolAddress={p.raw.poolAddress} tokenMint={p.raw.tokenXMint} />}
          />
          <div className="tabular text-muted text-sm">{age}</div>
          <div className="tabular text-sm text-text">{m.sol(p.sizeSol)}</div>
          <div
            className="tabular text-sm leading-tight"
            title={`${m.sol(p.raw.claimedFeesSol)} claimed · ${m.sol(p.raw.unclaimedFeesSol)} unclaimed`}
          >
            <div>
              <span className="text-muted">{m.sol(p.raw.claimedFeesSol)}</span>
              <span className="mx-1 text-faint">·</span>
              <span className="text-profit">{m.sol(p.raw.unclaimedFeesSol)}</span>
            </div>
            <div className="text-faint text-xs">
              {p.sizeSol > 0 ? `${p.feeYieldPct.toFixed(2)}%` : '—'}
            </div>
          </div>
          <PnlCell sol={p.pnlSol} pct={p.pnlPct} tone={p.tone} />
          <div className="flex flex-col items-end gap-1.5">
            <Badge tone={p.inRange ? 'in' : 'out'}>{rangeLabel(p.rangeStatus)}</Badge>
            <RangeBar placement={p.rangePlacement} inRange={p.inRange} className="max-w-32" />
          </div>
        </>
      }
    />
  );
}

function ListSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open positions</CardTitle>
      </CardHeader>
      <RowSkeleton gridCols={OPEN_COLS} rows={3} />
    </Card>
  );
}
