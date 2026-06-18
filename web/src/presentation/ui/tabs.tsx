'use client';

import { type KeyboardEvent, useRef } from 'react';
import { cn } from './cn';

type TabsProps<T extends string> = {
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
};

/** Top-level page navigation tabs — an accent underline marks the active section. Larger than the
 *  in-card Segmented filter so page-nav and filter read at different scales. Roving-tabindex + arrows. */
export function Tabs<T extends string>({ options, value, onChange, className }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const n =
      e.key === 'ArrowRight' ? (i + 1) % options.length : (i - 1 + options.length) % options.length;
    onChange(options[n]!.value);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" className={cn('flex items-center gap-1', className)}>
      {options.map((o, i) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              'relative cursor-pointer px-4 py-2.5 font-medium text-sm transition-colors',
              active ? 'text-text' : 'text-muted hover:text-text',
            )}
          >
            {o.label}
            {active && (
              <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-accent" />
            )}
          </button>
        );
      })}
    </div>
  );
}
