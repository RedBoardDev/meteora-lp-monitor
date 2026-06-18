import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'profit' | 'loss' | 'in' | 'out' | 'accent' | 'warn';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted',
  profit: 'bg-profit/12 text-profit',
  loss: 'bg-loss/12 text-loss',
  in: 'bg-in-range/12 text-in-range',
  out: 'bg-out-range/12 text-out-range',
  accent: 'bg-accent-soft text-accent',
  warn: 'bg-warn/12 text-warn',
};

type BadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone };

/** Compact status chip (range, strategy, tone). */
export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-medium text-xs',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
