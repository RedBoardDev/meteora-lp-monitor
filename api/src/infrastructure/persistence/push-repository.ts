import { and, eq } from 'drizzle-orm';
import type { Database } from './database';
import { pushSubscriptions, userWatchedWallets } from './schema';

/** A browser Web Push subscription (the parts web-push needs to deliver). */
export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Storage + wallet-scoped routing for Web Push subscriptions. */
export class PushRepository {
  constructor(private readonly db: Database) {}

  /** Upsert a subscription for an account (keyed by endpoint — re-subscribing is idempotent). */
  async save(userId: string, sub: PushSub): Promise<void> {
    await this.db
      .insert(pushSubscriptions)
      .values({
        endpoint: sub.endpoint,
        userId,
        p256dh: sub.p256dh,
        auth: sub.auth,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId, p256dh: sub.p256dh, auth: sub.auth, createdAt: Date.now() },
        // Only the endpoint's current owner may refresh it — an attacker who learns another user's
        // endpoint cannot reassign (take over) the subscription by re-subscribing under their own id.
        where: eq(pushSubscriptions.userId, userId),
      });
  }

  /** Remove THIS user's subscription by endpoint — the userId predicate blocks cross-user unsubscribe. */
  async remove(userId: string, endpoint: string): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
  }

  /** Internal prune of an endpoint the push service reported gone (404/410). Owner-agnostic on
   *  purpose — a dead endpoint belongs to no one — so it is NOT exposed on a user-facing route. */
  async pruneEndpoint(endpoint: string): Promise<void> {
    await this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  }

  /** This account's own subscriptions (for the "send test" action). */
  async forUser(userId: string): Promise<PushSub[]> {
    return this.db
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
  }

  /** Subscriptions to push for an event: every account watching `wallet`, or ALL for a global event. */
  async forWallet(wallet: string | null): Promise<PushSub[]> {
    const cols = {
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    };
    if (wallet == null) return this.db.select(cols).from(pushSubscriptions);
    const rows = await this.db
      .select(cols)
      .from(pushSubscriptions)
      .innerJoin(userWatchedWallets, eq(userWatchedWallets.userId, pushSubscriptions.userId))
      .where(eq(userWatchedWallets.walletAddress, wallet));
    // A user watches a wallet at most once, but dedup endpoints defensively.
    const seen = new Set<string>();
    return rows.filter((r) => {
      if (seen.has(r.endpoint)) return false;
      seen.add(r.endpoint);
      return true;
    });
  }
}
