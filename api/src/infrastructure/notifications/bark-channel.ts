import type { LiveEvent } from '@binsight/shared';
import type { Logger } from 'pino';
import type { NotificationChannel } from '@/domain/ports';

/** Pushes to iPhone via Bark (https://bark.day.app) — a simple HTTP GET, no Apple Dev. */
export class BarkChannel implements NotificationChannel {
  readonly name = 'bark';

  constructor(
    private readonly baseUrl: string,
    private getKey: () => string,
    private readonly logger: Logger,
  ) {}

  async deliver(event: LiveEvent): Promise<void> {
    const key = this.getKey();
    if (!key) return; // disabled
    const group = event.wallet ? `Meteora ${event.wallet.slice(0, 4)}` : 'Meteora';
    const url =
      `${this.baseUrl}/${encodeURIComponent(key)}` +
      `/${encodeURIComponent(event.title)}` +
      `/${encodeURIComponent(event.body)}` +
      `?group=${encodeURIComponent(group)}&level=${barkLevel(event)}`;
    try {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) this.logger.warn({ status: res.status, kind: event.kind }, 'Bark non-200');
    } catch (err) {
      this.logger.warn({ err, kind: event.kind }, 'Bark delivery failed');
    }
  }
}

function barkLevel(event: LiveEvent): 'active' | 'timeSensitive' | 'passive' {
  if (event.kind === 'oor_enter' || event.kind === 'oor_duration') return 'timeSensitive';
  if (event.kind.startsWith('system')) return 'passive';
  return 'active';
}
