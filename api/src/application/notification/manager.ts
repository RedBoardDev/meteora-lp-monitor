import type { ClosedPosition, EventKind, LiveEvent, NotifRule, WalletState } from '@meteora/shared';
import type { Logger } from 'pino';
import type { ConfigRepository, NotificationChannel } from '@/domain/ports';
import type { PresenceTracker } from '@/infrastructure/notifications/presence';
import type { EventBus } from '@/application/event-bus';
import { BulkBuffer } from './buffer';

const STARTUP_GRACE_MS = 10_000;

const fmt = (n: number) => (n >= 0 ? `+${n.toFixed(4)}` : n.toFixed(4));

export class NotificationManager {
  private rules: NotifRule[] = [];
  private seq = 0;
  private startAt = 0;
  private readonly notifiedThreshold = new Set<string>();
  private readonly buffer: BulkBuffer;

  constructor(
    private readonly bus: EventBus,
    private readonly config: ConfigRepository,
    private readonly presence: PresenceTracker,
    private readonly channel: NotificationChannel,
    private readonly logger: Logger,
  ) {
    this.buffer = new BulkBuffer((e) => this.deliver(e));
  }

  start(): void {
    this.startAt = Date.now();
    this.reloadRules();
    this.bus.on('event', (e) => this.handle(e));
    this.bus.on('closed', (c) => this.handleClosed(c));
    this.bus.on('state', (s) => this.deriveFromState(s));
  }

  reloadRules(): void {
    this.rules = this.config.listNotifRules();
  }

  private ruleFor(kind: EventKind, wallet: string | null): NotifRule | undefined {
    return (
      this.rules.find((r) => r.eventKind === kind && r.wallet === wallet) ??
      this.rules.find((r) => r.eventKind === kind && r.wallet === null)
    );
  }

  private handle(event: LiveEvent): void {
    const rule = this.ruleFor(event.kind, event.wallet);
    if (!rule?.enabled) return;
    if (rule.mode === 'bulk') this.buffer.add(event);
    else void this.deliver(event);
  }

  private handleClosed(c: ClosedPosition): void {
    this.bus.emit('event', {
      id: `${Date.now()}-${this.seq++}`,
      kind: 'position_close',
      wallet: c.wallet,
      positionAddress: c.positionAddress,
      pair: `${c.tokenX}/${c.tokenY}`,
      title: `${c.tokenX}/${c.tokenY} closed`,
      body: `PnL ${fmt(c.pnlSol)} SOL · fees ${fmt(c.feesSol)} SOL`,
      data: { pnlSol: c.pnlSol, feesSol: c.feesSol },
      createdAt: Date.now(),
    });
  }

  private deriveFromState(state: WalletState): void {
    if (state.scope === 'all') return;
    const now = Date.now();
    for (const p of state.openPositions) {
      const pnlRule = this.ruleFor('pnl_threshold', p.wallet);
      if (pnlRule?.enabled && pnlRule.threshold != null) {
        if (Math.abs(p.pnlSol) >= pnlRule.threshold) {
          this.once(`pnl:${p.positionAddress}`, () =>
            this.emitDerived('pnl_threshold', p.wallet, p.positionAddress, `${p.tokenX}/${p.tokenY}`, `PnL ${fmt(p.pnlSol)} SOL`, { pnlSol: p.pnlSol }),
          );
        } else {
          this.notifiedThreshold.delete(`pnl:${p.positionAddress}`);
        }
      }
      const feeRule = this.ruleFor('fees_threshold', p.wallet);
      if (feeRule?.enabled && feeRule.threshold != null) {
        if (p.unclaimedFeesSol >= feeRule.threshold) {
          this.once(`fees:${p.positionAddress}`, () =>
            this.emitDerived('fees_threshold', p.wallet, p.positionAddress, `${p.tokenX}/${p.tokenY}`, `${fmt(p.unclaimedFeesSol)} SOL fees to claim`, { feesSol: p.unclaimedFeesSol }),
          );
        } else {
          this.notifiedThreshold.delete(`fees:${p.positionAddress}`);
        }
      }
      const oorRule = this.ruleFor('oor_duration', p.wallet);
      if (oorRule?.enabled && oorRule.oorMinutes != null && p.outOfRangeSince != null) {
        const minutes = (now - p.outOfRangeSince) / 60_000;
        if (minutes >= oorRule.oorMinutes) {
          this.once(`oord:${p.positionAddress}:${Math.floor(p.outOfRangeSince)}`, () =>
            this.emitDerived('oor_duration', p.wallet, p.positionAddress, `${p.tokenX}/${p.tokenY}`, `out of range ${Math.floor(minutes)} min`, { minutes: Math.floor(minutes) }),
          );
        }
      }
    }
  }

  private once(key: string, fn: () => void): void {
    if (this.notifiedThreshold.has(key)) return;
    this.notifiedThreshold.add(key);
    if (this.inStartupGrace()) return;
    fn();
  }

  private emitDerived(
    kind: EventKind,
    wallet: string | null,
    positionAddress: string | null,
    pair: string,
    title: string,
    data: LiveEvent['data'],
  ): void {
    // Single path: the 'event' bus listener broadcasts to clients AND applies rules → Bark.
    // Avoids double-routing by not calling handle() here.
    this.bus.emit('event', {
      id: `${Date.now()}-${this.seq++}`,
      kind,
      wallet,
      positionAddress,
      pair,
      title: `${pair} · ${title}`,
      body: title,
      data,
      createdAt: Date.now(),
    });
  }

  private inStartupGrace(): boolean {
    return Date.now() - this.startAt < STARTUP_GRACE_MS;
  }

  /** Presence-aware routing: Mac active → native (already via WS); else → Bark. */
  private async deliver(event: LiveEvent): Promise<void> {
    if (this.inStartupGrace()) {
      this.logger.info({ kind: event.kind }, 'route: held (startup grace, awaiting presence)');
      return;
    }
    const active = this.presence.isAnyClientActive();
    this.logger.info(
      { kind: event.kind, clientActive: active },
      active ? 'route: native (client active), skipping Bark' : 'route: Bark (no client active)',
    );
    if (active) {
      // Native banner only for rules the user enabled — handle() gates this path.
      this.bus.emit('notify', event);
      return;
    }
    await this.channel.deliver(event);
  }
}
