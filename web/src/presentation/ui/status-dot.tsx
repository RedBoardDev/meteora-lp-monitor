import type { SourceStatus } from '@meteora/shared';
import { cn } from './cn';

const COLOR: Record<SourceStatus, string> = {
  ok: 'bg-profit',
  lagging: 'bg-warn',
  down: 'bg-loss',
};

/** Small health dot; pulses softly when healthy. */
export function StatusDot({ status, className }: { status: SourceStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2', className)}>
      {status === 'ok' && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-profit/60" />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', COLOR[status])} />
    </span>
  );
}
