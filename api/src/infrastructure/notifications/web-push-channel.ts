import type { LiveEvent } from '@binsight/shared';
import type { Logger } from 'pino';
import webpush from 'web-push';
import type { NotificationChannel } from '@/domain/ports';
import type { PushRepository, PushSub } from '@/infrastructure/persistence/push-repository';

/** Delivers notifications to browsers/PWAs via the Web Push protocol (VAPID). Routes each event to the
 *  subscriptions of accounts watching its wallet; prunes endpoints the push service reports as gone. */
export class WebPushChannel implements NotificationChannel {
  readonly name = 'webpush';
  private readonly enabled: boolean;

  constructor(
    private readonly repo: PushRepository,
    vapid: { publicKey: string; privateKey: string; subject: string },
    private readonly logger: Logger,
  ) {
    this.enabled = Boolean(vapid.publicKey && vapid.privateKey);
    if (this.enabled) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    else logger.info('web push disabled (no VAPID keys)');
  }

  async deliver(event: LiveEvent): Promise<void> {
    if (!this.enabled) return;
    const subs = await this.repo.forWallet(event.wallet);
    await this.pushAll(subs, { title: event.title, body: event.body, url: '/', tag: event.kind });
  }

  /** Send a one-off test notification to a given set of subscriptions (the settings "Send test"). */
  async sendTest(subs: PushSub[]): Promise<number> {
    if (!this.enabled) return 0;
    await this.pushAll(subs, {
      title: 'Binsight',
      body: 'Test alert — push notifications are working ✅',
      url: '/',
      tag: 'test',
    });
    return subs.length;
  }

  private async pushAll(
    subs: PushSub[],
    payload: { title: string; body: string; url: string; tag: string },
  ): Promise<void> {
    if (subs.length === 0) return;
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
          );
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410)
            await this.repo.remove(s.endpoint); // gone — prune
          else this.logger.warn({ err, tag: payload.tag }, 'web-push delivery failed');
        }
      }),
    );
  }
}
