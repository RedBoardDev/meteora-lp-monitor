import type {
  ClosedPosition,
  OpenPosition,
  RangeStatus,
  StrategyFamily,
  WalletState,
} from '@binsight/shared';

export type Tone = 'profit' | 'loss' | 'neutral';

/** The single source of truth for mapping a signed value to a profit/loss/neutral tone. */
export const toneOf = (value: number): Tone =>
  value > 0 ? 'profit' : value < 0 ? 'loss' : 'neutral';

/** An open position with the derived values the UI needs (range placement, tone, total fees). */
export class OpenPositionEntity {
  constructor(readonly raw: OpenPosition) {}

  get address(): string {
    return this.raw.positionAddress;
  }
  get pair(): string {
    return `${this.raw.tokenX}/${this.raw.tokenY}`;
  }
  get strategy(): StrategyFamily | null {
    return this.raw.strategy;
  }
  get sizeSol(): number {
    return this.raw.sizeSol;
  }
  get pnlSol(): number {
    return this.raw.pnlSol;
  }
  get pnlPct(): number {
    return this.raw.pnlPctSol;
  }
  get tone(): Tone {
    return toneOf(this.raw.pnlSol);
  }
  get totalFeesSol(): number {
    return this.raw.claimedFeesSol + this.raw.unclaimedFeesSol;
  }
  /** Combined (claimed + unclaimed) fees as a percentage of the position's current value. */
  get feeYieldPct(): number {
    return this.sizeSol > 0 ? (this.totalFeesSol / this.sizeSol) * 100 : 0;
  }
  get rangeStatus(): RangeStatus {
    return this.raw.rangeStatus;
  }
  get inRange(): boolean {
    return this.raw.rangeStatus === 'in';
  }

  /** Where the live pool price sits inside [min,max], clamped to 0..1. Null if not priceable. */
  get rangePlacement(): number | null {
    const { poolPrice, minPrice, maxPrice } = this.raw;
    if (poolPrice == null || maxPrice <= minPrice) return null;
    return Math.min(1, Math.max(0, (poolPrice - minPrice) / (maxPrice - minPrice)));
  }
}

/** A closed position with derived win/tone/duration helpers. */
export class ClosedPositionEntity {
  constructor(readonly raw: ClosedPosition) {}

  get address(): string {
    return this.raw.positionAddress;
  }
  get pair(): string {
    return `${this.raw.tokenX}/${this.raw.tokenY}`;
  }
  get strategy(): StrategyFamily | null {
    return this.raw.strategy;
  }
  get pnlSol(): number {
    return this.raw.pnlSol;
  }
  get pnlPct(): number {
    return this.raw.pnlPctSol;
  }
  get feesSol(): number {
    return this.raw.feesSol;
  }
  get tone(): Tone {
    return toneOf(this.raw.pnlSol);
  }
  get isWin(): boolean {
    return this.raw.pnlSol > 0;
  }
  get closedAt(): number | null {
    return this.raw.closedAt;
  }
  get durationSeconds(): number | null {
    return this.raw.durationSeconds;
  }
}

/** The aggregated wallet snapshot, with open positions mapped to entities. */
export class Portfolio {
  readonly open: OpenPositionEntity[];

  constructor(readonly state: WalletState) {
    this.open = state.openPositions.map((p) => new OpenPositionEntity(p));
  }

  get totals() {
    return this.state.totals;
  }
  get scope(): string {
    return this.state.scope;
  }
  get freshness() {
    return this.state.freshness;
  }
  get asOfSlot(): number | null {
    return this.state.asOfSlot;
  }
  get updatedAt(): number {
    return this.state.updatedAt;
  }

  /** Open positions sorted by current size, largest first. */
  get openByValue(): OpenPositionEntity[] {
    return [...this.open].sort((a, b) => b.sizeSol - a.sizeSol);
  }
}
