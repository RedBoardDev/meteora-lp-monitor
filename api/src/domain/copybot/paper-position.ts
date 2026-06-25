/**
 * Copy-bot · P2.4 — ledger of the PAPER positions we hold (PURE, no I/O). In paper, 1 copied leader position
 * ⇒ 1 mirror position on our side; so we key by the LEADER position pubkey (open↔close link).
 *
 * Role: to enable the mirror-leader-close. On entry (open mirrored/reduced) we record the mirror
 * (`openMirror`); when the leader closes THIS position, `closeMirror` tells us whether we held an open
 * position to close (the pillar: never miss a close of what we copy). We do NOT hold the opens we
 * skipped (non-SOL, below floor, insufficient balance), so their close is a no-op.
 *
 * Idempotent: re-opening an already-open position does not duplicate it; re-closing an already-closed
 * position is a no-op (no double-log).
 */

export interface PaperPosition {
  /** key = pubkey of the copied LEADER position (1:1 with our paper mirror). */
  leaderPosition: string;
  pool: string;
  nonSolMint: string | null;
  nonSolSymbol: string | null;
  /** SOL size we (paper-)opened (from the sizing decision). */
  sizeSol: number;
  status: 'open' | 'closed';
  openSignature: string;
  /** wall-clock ms when WE opened the mirror (≠ leader blockTime) — basis of the caps sliding window. */
  openedAtMs: number;
  openedAtBlockTime: number | null;
  closeSignature: string | null;
  closedAtBlockTime: number | null;
}

export class PaperPositionLedger {
  private readonly positions = new Map<string, PaperPosition>();

  /** Records an open mirror. Idempotent: if already open for this leader position, returns the existing one. */
  openMirror(p: {
    leaderPosition: string;
    pool: string;
    nonSolMint: string | null;
    nonSolSymbol: string | null;
    sizeSol: number;
    openSignature: string;
    blockTime: number | null;
    openedAtMs: number;
  }): PaperPosition {
    const existing = this.positions.get(p.leaderPosition);
    if (existing && existing.status === 'open') return existing;
    const pos: PaperPosition = {
      leaderPosition: p.leaderPosition,
      pool: p.pool,
      nonSolMint: p.nonSolMint,
      nonSolSymbol: p.nonSolSymbol,
      sizeSol: p.sizeSol,
      status: 'open',
      openSignature: p.openSignature,
      openedAtMs: p.openedAtMs,
      openedAtBlockTime: p.blockTime,
      closeSignature: null,
      closedAtBlockTime: null,
    };
    this.positions.set(p.leaderPosition, pos);
    return pos;
  }

  /** Closes the mirror of this leader position if we hold one OPEN. Returns the closed position, or
   *  `undefined` if we hold nothing (open skipped / never opened) or if it's already closed (no-op). */
  closeMirror(leaderPosition: string, closeSignature: string, blockTime: number | null): PaperPosition | undefined {
    const pos = this.positions.get(leaderPosition);
    if (!pos || pos.status === 'closed') return undefined;
    pos.status = 'closed';
    pos.closeSignature = closeSignature;
    pos.closedAtBlockTime = blockTime;
    return pos;
  }

  get(leaderPosition: string): PaperPosition | undefined {
    return this.positions.get(leaderPosition);
  }

  openPositions(): PaperPosition[] {
    return [...this.positions.values()].filter((p) => p.status === 'open');
  }

  /** All known mirrors (open + closed) — e.g. for the caps sliding window. */
  all(): PaperPosition[] {
    return [...this.positions.values()];
  }
}
