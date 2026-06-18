import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from './cn';

/** Bordered text input. Forwards all native props (and ref); className extends the base style. */
export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text transition-colors placeholder:text-faint focus:border-border-strong',
        className,
      )}
      {...props}
    />
  );
}
