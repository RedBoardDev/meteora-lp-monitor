import type { ReactNode } from 'react';
import { Button } from './button';
import { cn } from './cn';
import { IconWarn } from './icons';

/** Quiet placeholder for empty lists/tables — or, with variant="error", a distinct failure state. */
export function EmptyState({
  icon,
  title,
  hint,
  variant = 'empty',
  onRetry,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  variant?: 'empty' | 'error';
  onRetry?: () => void;
}) {
  const isError = variant === 'error';
  const glyph = icon ?? (isError ? <IconWarn size={18} /> : null);
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {glyph != null && (
        <span
          className={cn(
            'mb-1 grid size-9 place-items-center rounded-full',
            isError ? 'bg-loss/12 text-loss' : 'bg-surface-2 text-faint',
          )}
        >
          {glyph}
        </span>
      )}
      <p className={cn('font-medium text-sm', isError ? 'text-text' : 'text-muted')}>{title}</p>
      {hint != null && <p className="text-faint text-xs">{hint}</p>}
      {isError && onRetry && (
        <Button variant="subtle" onClick={onRetry} className="mt-2">
          Retry
        </Button>
      )}
    </div>
  );
}
