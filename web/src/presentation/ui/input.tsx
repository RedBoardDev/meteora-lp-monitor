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
        // Mobile-first: text-base avoids iOS focus-zoom and py-2.5 gives a ~44px tap target; `md:` restores
        // the exact desktop sizing (text-sm / py-2) so the ≥768px appearance is unchanged.
        'w-full rounded-md border border-border bg-bg px-3 py-2.5 text-base text-text transition-colors placeholder:text-faint focus:border-border-strong md:py-2 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}
