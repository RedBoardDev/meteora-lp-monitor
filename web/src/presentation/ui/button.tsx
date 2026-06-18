'use client';

import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'subtle' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-bg shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)] hover:brightness-110 hover:shadow-glow',
  subtle: 'bg-surface-2 text-text hover:bg-hover',
  ghost: 'bg-transparent text-muted hover:bg-hover hover:text-text',
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant };

export function Button({ variant = 'primary', className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 font-medium text-sm transition duration-[var(--dur-fast)] ease-[var(--ease-out)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
