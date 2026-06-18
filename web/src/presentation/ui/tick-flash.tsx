'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from './cn';

/**
 * Wraps a live value and briefly washes its background green/red when the numeric `value` changes
 * (a re-key restarts the one-shot CSS animation). Purely visual feedback for socket-driven updates;
 * the global reduced-motion rule disables the flash.
 */
export function TickFlash({
  value,
  className,
  children,
}: {
  value: number;
  className?: string;
  children: ReactNode;
}) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<{ dir: '' | 'up' | 'down'; n: number }>({ dir: '', n: 0 });

  useEffect(() => {
    if (value === prev.current) return;
    const dir = value > prev.current ? 'up' : 'down';
    prev.current = value;
    setFlash((f) => ({ dir, n: f.n + 1 }));
  }, [value]);

  return (
    <span
      key={flash.n}
      className={cn(
        '-mx-1 rounded px-1',
        flash.dir === 'up' && 'tick-up',
        flash.dir === 'down' && 'tick-down',
        className,
      )}
    >
      {children}
    </span>
  );
}
