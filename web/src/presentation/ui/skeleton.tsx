import { cn } from './cn';

/** Loading placeholder with a subtle shimmer sweep (see `.skeleton` in globals.css). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} />;
}
