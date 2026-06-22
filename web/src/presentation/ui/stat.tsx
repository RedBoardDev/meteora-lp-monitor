import type { ReactNode } from 'react';
import type { Tone } from '@/domain/position';
import { cn } from './cn';
import { toneText } from './tone';

type StatProps = {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  className?: string;
};

/** A labelled headline metric: caption, large tabular value, optional sub-line. */
export function Stat({ label, value, sub, tone = 'neutral', className }: StatProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="font-medium text-faint text-xs uppercase tracking-wide">{label}</span>
      <span
        className={cn('tabular font-semibold text-xl leading-none md:text-2xl', toneText[tone])}
      >
        {value}
      </span>
      {sub != null && <span className="tabular text-muted text-sm">{sub}</span>}
    </div>
  );
}
