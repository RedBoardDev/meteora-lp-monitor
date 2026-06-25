/**
 * Copy-bot · Inc.2 — registry of the positions we COPY (brain), keyed by the LEADER position (mono-user:
 * 1 copied leader position ⇒ 1 mirror on our side). PURE. Lets us find OUR position + its range for
 * mirror-close / mirror-claim when the leader acts. Idempotent (re-opening an open mirror = no-op;
 * re-closing = no-op).
 */
export interface Mirror {
  /** key = pubkey of the COPIED LEADER position. */
  leaderPosition: string;
  /** pubkey of OUR position (generated at open). */
  ourPosition: string;
  pool: string;
  nonSolSymbol: string | null;
  sizeSol: number;
  /** re-anchored bin range of OUR position (for the close). */
  lowerBin: number;
  upperBin: number;
  /** epoch ms when we opened the copy — drives the reconcile open-grace (a fresh open's on-chain absence
   *  is not yet trustworthy). Persisted so the grace survives a brain restart. */
  openedAt: number;
  status: 'open' | 'closed';
}

export class MirrorRegistry {
  private readonly mirrors = new Map<string, Mirror>();

  /** Registers an open mirror. Idempotent: if already open for this leader position, returns the existing one. */
  open(m: Omit<Mirror, 'status'>): Mirror {
    const existing = this.mirrors.get(m.leaderPosition);
    if (existing && existing.status === 'open') return existing;
    const mirror: Mirror = { ...m, status: 'open' };
    this.mirrors.set(m.leaderPosition, mirror);
    return mirror;
  }

  get(leaderPosition: string): Mirror | undefined {
    return this.mirrors.get(leaderPosition);
  }

  /** Reverse lookup by OUR position (e.g. an `ev:executed` close carries our pubkey, not the leader's). Any status. */
  getByOurPosition(ourPosition: string): Mirror | undefined {
    for (const m of this.mirrors.values()) if (m.ourPosition === ourPosition) return m;
    return undefined;
  }

  /** Do we hold an OPEN mirror for this leader position? */
  hasOpen(leaderPosition: string): boolean {
    return this.mirrors.get(leaderPosition)?.status === 'open';
  }

  /** Update the tracked SOL size after a proportional add/remove (clamped at 0). No-op if not open. */
  adjustSize(leaderPosition: string, newSizeSol: number): void {
    const mirror = this.mirrors.get(leaderPosition);
    if (mirror && mirror.status === 'open') mirror.sizeSol = Math.max(0, newSizeSol);
  }

  /** Closes the mirror if we hold an open one; returns the closed position, otherwise undefined (no-op). */
  close(leaderPosition: string): Mirror | undefined {
    const mirror = this.mirrors.get(leaderPosition);
    if (!mirror || mirror.status === 'closed') return undefined;
    mirror.status = 'closed';
    return mirror;
  }

  openPositions(): Mirror[] {
    return [...this.mirrors.values()].filter((m) => m.status === 'open');
  }
}
