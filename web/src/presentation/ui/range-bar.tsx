import { cn } from './cn';

type RangeBarProps = {
  /** pool-price placement within [min,max], 0..1; null when not priceable. */
  placement: number | null;
  inRange: boolean;
  className?: string;
};

/** Min↔max range track with a marker showing where the live price sits. */
export function RangeBar({ placement, inRange, className }: RangeBarProps) {
  const pct = placement == null ? null : Math.min(100, Math.max(0, placement * 100));
  const accent = inRange ? 'bg-in-range' : 'bg-out-range';
  return (
    <div className={cn('relative h-1.5 w-full rounded-full bg-surface-2', className)}>
      <div className={cn('absolute inset-0 rounded-full opacity-25', accent)} />
      {pct != null && (
        <span
          className={cn(
            '-translate-x-1/2 -translate-y-1/2 absolute top-1/2 size-2.5 rounded-full border-2 border-bg',
            accent,
          )}
          style={{ left: `${pct}%` }}
        />
      )}
    </div>
  );
}
