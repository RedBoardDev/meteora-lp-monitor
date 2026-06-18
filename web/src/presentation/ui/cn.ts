type ClassValue = string | number | false | null | undefined;

/** Minimal className joiner — filters falsy values. No dependency, no dedup needed here. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
