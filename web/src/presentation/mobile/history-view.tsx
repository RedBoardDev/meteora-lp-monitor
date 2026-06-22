'use client';

import { Pagination } from '@/presentation/components/pagination';
import {
  CLOSED_RESULTS,
  CLOSED_SORTS,
  useClosedQuery,
} from '@/presentation/hooks/use-closed-query';
import {
  cn,
  EmptyState,
  IconArrowDown,
  IconArrowUp,
  IconClose,
  IconDownload,
  IconSearch,
  Input,
  Segmented,
  Skeleton,
} from '@/presentation/ui';
import { ClosedPositionCard } from './position-card';
import { SectionHeader } from './section-header';

/** Mobile "History" tab: compact filter controls over closed positions rendered as cards. */
export function MobileHistoryView() {
  const cq = useClosedQuery();
  const now = Date.now();

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">
          <IconSearch />
        </span>
        <Input
          value={cq.qInput}
          onChange={(e) => cq.setQInput(e.target.value)}
          placeholder="Search pair…"
          spellCheck={false}
          className="pr-9 pl-9"
        />
        {cq.qInput && (
          <button
            type="button"
            onClick={() => cq.setQInput('')}
            aria-label="Clear search"
            className="absolute inset-y-0 right-2 flex items-center rounded-md px-1 text-faint transition-colors hover:text-text"
          >
            <IconClose size={16} />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented options={CLOSED_RESULTS} value={cq.result} onChange={cq.setResult} />
        <Segmented options={CLOSED_SORTS} value={cq.sort} onChange={cq.setSort} />
        <button
          type="button"
          onClick={() => cq.setDir(cq.dir === 'asc' ? 'desc' : 'asc')}
          aria-label={cq.dir === 'asc' ? 'Sort ascending' : 'Sort descending'}
          className="grid size-8 place-items-center rounded-md bg-surface-2 text-muted transition-colors active:bg-hover"
        >
          {cq.dir === 'asc' ? <IconArrowUp /> : <IconArrowDown />}
        </button>
        <button
          type="button"
          onClick={cq.exportCsv}
          disabled={cq.total === 0}
          aria-label="Export CSV"
          title="Export current filter as CSV"
          className="grid size-8 place-items-center rounded-md bg-surface-2 text-muted transition-colors active:bg-hover disabled:opacity-40"
        >
          <IconDownload />
        </button>
      </div>

      <SectionHeader title="Closed" count={cq.total} />

      {cq.error && !cq.hasData ? (
        <EmptyState
          variant="error"
          title="Couldn't load history"
          hint="Check the connection."
          onRetry={cq.refetch}
        />
      ) : cq.loading && !cq.hasData ? (
        <>
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </>
      ) : cq.rows.length === 0 ? (
        <EmptyState
          title={cq.q || cq.result !== 'all' ? 'No matching trades' : 'No closed positions'}
          hint={cq.q || cq.result !== 'all' ? 'Try clearing the filters.' : undefined}
        />
      ) : (
        <div
          className={cn('flex flex-col gap-2.5 transition-opacity', cq.stale && 'opacity-60')}
          aria-busy={cq.stale}
        >
          {cq.rows.map((p) => (
            <ClosedPositionCard key={p.address} p={p} now={now} />
          ))}
        </div>
      )}

      <Pagination
        page={cq.page}
        pages={cq.pages}
        onPrev={() => cq.setPage((p) => p - 1)}
        onNext={() => cq.setPage((p) => p + 1)}
      />
    </div>
  );
}
