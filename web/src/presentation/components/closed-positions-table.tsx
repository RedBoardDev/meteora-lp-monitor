'use client';

import { useState } from 'react';
import { useUi } from '@/application/stores/ui-store';
import { fmtDuration, fmtRelative } from '@/domain/format';
import type { ClosedPositionEntity } from '@/domain/position';
import {
  CLOSED_RESULTS,
  CLOSED_SORTS,
  useClosedQuery,
} from '@/presentation/hooks/use-closed-query';
import { useMoney } from '@/presentation/hooks/use-money';
import {
  Card,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  IconArrowDown,
  IconArrowUp,
  IconClose,
  IconDownload,
  IconSearch,
  Input,
  Segmented,
} from '@/presentation/ui';
import { Pagination } from './pagination';
import { PnlCell, PoolActions, RowHeader, RowShell, RowSkeleton, TokenPair } from './position-row';

// The Pair column carries the icons, name, strategy badge and (on hover) three action icons, so it
// gets the lion's share; the remaining columns hold short numbers and don't need the slack.
const CLOSED_COLS = '2.6fr 0.7fr 0.9fr 0.9fr 1fr 0.9fr';

export function ClosedPositionsTable() {
  const {
    hasData,
    qInput,
    setQInput,
    q,
    result,
    setResult,
    sort,
    setSort,
    dir,
    setDir,
    page,
    setPage,
    rows,
    total,
    pages,
    loading,
    stale,
    error,
    refetch,
    exportCsv,
  } = useClosedQuery();
  const [openChart, setOpenChart] = useState<string | null>(null);
  const now = Date.now();
  const toggleChart = (addr: string) => setOpenChart((c) => (c === addr ? null : addr));

  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <span className="tabular text-faint text-xs">{total}</span>
      </CardHeader>

      <div className="flex flex-wrap items-center gap-2 border-border border-b px-5 py-3">
        <div className="relative w-40">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-faint">
            <IconSearch />
          </span>
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Search pair…"
            spellCheck={false}
            className="py-1.5 pr-8 pl-8"
          />
          {qInput && (
            <button
              type="button"
              onClick={() => setQInput('')}
              aria-label="Clear search"
              className="absolute inset-y-0 right-1.5 flex items-center rounded-md px-1 text-faint transition-colors hover:text-text"
            >
              <IconClose size={14} />
            </button>
          )}
        </div>
        <Segmented options={CLOSED_RESULTS} value={result} onChange={setResult} />
        <div className="ml-auto flex items-center gap-2">
          <Segmented options={CLOSED_SORTS} value={sort} onChange={setSort} />
          <button
            type="button"
            onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')}
            aria-label={dir === 'asc' ? 'Sort ascending' : 'Sort descending'}
            className="rounded-md bg-surface-2 p-1.5 text-muted transition-colors hover:bg-hover hover:text-text"
          >
            {dir === 'asc' ? <IconArrowUp /> : <IconArrowDown />}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={total === 0}
            aria-label="Export CSV"
            title="Export current filter as CSV"
            className="rounded-md bg-surface-2 p-1.5 text-muted transition-colors hover:bg-hover hover:text-text disabled:opacity-40"
          >
            <IconDownload />
          </button>
        </div>
      </div>

      {error && !hasData ? (
        <EmptyState
          variant="error"
          title="Couldn't load history"
          hint="Check the connection."
          onRetry={refetch}
        />
      ) : loading && !hasData ? (
        <RowSkeleton gridCols={CLOSED_COLS} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={q || result !== 'all' ? 'No matching trades' : 'No closed positions'}
          hint={q || result !== 'all' ? 'Try clearing the filters.' : undefined}
        />
      ) : (
        <div
          className={cn('overflow-x-auto transition-opacity', stale && 'opacity-60')}
          aria-busy={stale}
        >
          <RowHeader gridCols={CLOSED_COLS}>
            <span>Pair</span>
            <span>Age</span>
            <span>Invested</span>
            <span>Fees</span>
            <span>PnL</span>
            <span className="text-right">Closed</span>
          </RowHeader>
          <div className="divide-y divide-border">
            {rows.map((p) => (
              <ClosedRow
                key={p.address}
                p={p}
                now={now}
                chartOpen={openChart === p.address}
                onToggleChart={() => toggleChart(p.address)}
              />
            ))}
          </div>
        </div>
      )}

      <Pagination
        page={page}
        pages={pages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </Card>
  );
}

function ClosedRow({
  p,
  now,
  chartOpen,
  onToggleChart,
}: {
  p: ClosedPositionEntity;
  now: number;
  chartOpen: boolean;
  onToggleChart: () => void;
}) {
  const select = useUi((s) => s.select);
  const m = useMoney();
  return (
    <RowShell
      gridCols={CLOSED_COLS}
      chart={{
        positionAddress: p.address,
        poolAddress: p.raw.poolAddress,
        tokenX: p.raw.tokenX,
        tokenMint: p.raw.tokenXMint,
        minPrice: p.raw.minPrice,
        maxPrice: p.raw.maxPrice,
        openedAt: p.raw.openedAt,
        closedAt: p.raw.closedAt,
      }}
      chartOpen={chartOpen}
      onToggleChart={onToggleChart}
      onOpen={() => select({ address: p.address, pair: p.pair, open: false, closed: p.raw })}
      cols={
        <>
          <TokenPair
            pair={p.pair}
            iconX={p.raw.tokenXIcon}
            iconY={p.raw.tokenYIcon}
            strategy={p.strategy}
            actions={
              <PoolActions
                poolAddress={p.raw.poolAddress}
                tokenMint={p.raw.tokenXMint}
                shareClosed={p.raw}
              />
            }
          />
          <div className="tabular text-muted text-sm">{fmtDuration(p.durationSeconds)}</div>
          <div className="tabular text-muted text-sm">{m.sol(p.raw.depositSol)}</div>
          <div className="tabular text-sm text-text">{m.sol(p.feesSol)}</div>
          <PnlCell sol={p.pnlSol} pct={p.pnlPct} tone={p.tone} />
          <div className="tabular text-right text-muted text-xs">
            {fmtRelative(p.closedAt, now)}
          </div>
        </>
      }
    />
  );
}
