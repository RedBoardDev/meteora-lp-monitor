import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** Shared floating panel — used by the chart tooltip and the health popover for a consistent look. */
export function Tooltip({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-bg-elevated px-3 py-2 text-xs shadow-pop',
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px',
        'before:bg-gradient-to-r before:from-transparent before:via-[color:var(--color-highlight)] before:to-transparent',
        className,
      )}
      {...props}
    />
  );
}
