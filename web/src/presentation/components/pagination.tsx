'use client';

import { Button } from '@/presentation/ui';

/** Centered Prev · page-indicator · Next. Renders nothing for a single page. */
export function Pagination({
  page,
  pages,
  onPrev,
  onNext,
}: {
  page: number;
  pages: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-6 border-border border-t px-5 py-3">
      <Button variant="ghost" disabled={page <= 1} onClick={onPrev}>
        Previous
      </Button>
      <span className="tabular text-faint text-xs">
        {page} / {pages}
      </span>
      <Button variant="ghost" disabled={page >= pages} onClick={onNext}>
        Next
      </Button>
    </div>
  );
}
