'use client';

import { cn } from './cn';

type Option<T extends string> = { label: string; value: T };

type SegmentedProps<T extends string> = {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
};

/** Compact segmented control (e.g. chart bucket, scope switch). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: SegmentedProps<T>) {
  return (
    <div className={cn('inline-flex rounded-md bg-surface-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-sm px-3 py-1 font-medium text-xs transition-colors duration-150',
            value === o.value
              ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
              : 'text-muted hover:bg-highlight hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
