/** Coerce an unknown (string-aware) value to a finite number, falling back when it isn't one. */
export function toFiniteNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
