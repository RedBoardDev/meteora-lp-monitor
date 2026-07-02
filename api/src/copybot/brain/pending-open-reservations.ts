/**
 * Copy-bot · TTL-bounded PENDING-OPEN reservations (PURE, no I/O). A leader OPEN is copied by a handler that only
 * calls `registry.open(...)` at the END. For MULTI-TX opens (two-sided buy→open, Token-2022 create→deposit, wide
 * split) the open handler RETURNS before `registry.open` — that runs later in an ev:executed continuation. During
 * that window `registry.hasOpen(pos)` is still false, so a follow-up leader add on the same position would re-route
 * to a SECOND open (real-money double open). A reservation marks a position as "open in flight" the moment we route
 * it to `open`, so the follow-up event routes to resync/ignore (like a normal add) instead of a duplicate open.
 *
 * Self-healing by design: each entry carries a timestamp and is ignored (and lazily deleted) once older than the
 * TTL. A leaked reservation therefore only suppresses re-opening the SAME leader position for ≤TTL — it can NEVER
 * cause a missed close or a permanent block, and NEVER a double open. The TTL must exceed the longest multi-tx open
 * window (buy/create land + deposit land) so the reservation stays live until `registry.open` clears it.
 */
export interface PendingOpenReservations {
  /** Mark `pos` as having an open in flight (called right before the open handler runs). */
  reserve(pos: string): void;
  /** True iff `pos` has a non-stale reservation. Deletes the entry lazily if stale (self-healing). */
  isPending(pos: string): boolean;
  /** Clear `pos`'s reservation (called at each `registry.open` site, keyed by the leader position). */
  clear(pos: string): void;
  /** Number of live entries (test/observability only). */
  size(): number;
}

export function createPendingOpenReservations(ttlMs: number, now: () => number = Date.now): PendingOpenReservations {
  const reservedAt = new Map<string, number>();
  return {
    reserve: (pos) => {
      reservedAt.set(pos, now());
    },
    isPending: (pos) => {
      const ts = reservedAt.get(pos);
      if (ts === undefined) return false;
      if (now() - ts >= ttlMs) {
        reservedAt.delete(pos); // stale → self-heal (a leaked reservation clears itself after the TTL)
        return false;
      }
      return true;
    },
    clear: (pos) => {
      reservedAt.delete(pos);
    },
    size: () => reservedAt.size,
  };
}
