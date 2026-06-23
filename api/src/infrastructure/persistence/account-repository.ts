import { randomUUID } from 'node:crypto';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type {
  AccessEntry,
  AccountRepository,
  AccountSummary,
  AccountUser,
  NoncePurpose,
  WalletOverview,
  WhitelistEntry,
} from '@/domain/ports';
import type { Database } from './database';
import {
  authNonces,
  authSessions,
  positions as positionsTable,
  users as usersTable,
  userWatchedWallets as uww,
  walletWhitelist,
} from './schema';

/**
 * Postgres-backed accounts (Drizzle). Identity is the Solana wallet **address** (= username), proven by
 * a one-time signature at registration and protected by a password thereafter. Also owns the
 * registration whitelist (owner-managed gate) and the single-use signature nonces.
 */
export class PostgresAccountRepository implements AccountRepository {
  constructor(private readonly db: Database) {}

  /** Seed the owner allowlist entry so the owner can register the bootstrap account (idempotent). */
  async init(ownerAddress: string): Promise<void> {
    if (!ownerAddress) return;
    await this.db
      .insert(walletWhitelist)
      .values({
        address: ownerAddress,
        note: 'owner bootstrap',
        addedBy: 'system',
        createdAt: Date.now(),
      })
      .onConflictDoNothing({ target: walletWhitelist.address });
  }

  async createUser(p: {
    address: string;
    passwordHash: string;
    isOwner: boolean;
  }): Promise<AccountUser> {
    const id = randomUUID();
    await this.db.insert(usersTable).values({
      id,
      address: p.address,
      passwordHash: p.passwordHash,
      isOwner: p.isOwner,
      tokenVersion: 0,
      createdAt: Date.now(),
    });
    return { id, address: p.address, isOwner: p.isOwner, tokenVersion: 0 };
  }

  async findByAddress(
    address: string,
  ): Promise<{ user: AccountUser; passwordHash: string } | null> {
    const [r] = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.address, address))
      .limit(1);
    if (!r) return null;
    return {
      user: { id: r.id, address: r.address, isOwner: r.isOwner, tokenVersion: r.tokenVersion },
      passwordHash: r.passwordHash,
    };
  }

  async findById(id: string): Promise<AccountUser | null> {
    const [r] = await this.db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    return r
      ? { id: r.id, address: r.address, isOwner: r.isOwner, tokenVersion: r.tokenVersion }
      : null;
  }

  /** The account for `id` ONLY if its `jti` session is still allow-listed + unexpired — one JOIN query
   *  for the auth hot path (was findById THEN isSessionValid, two sequential round-trips per request). */
  async findByIdWithSession(id: string, jti: string): Promise<AccountUser | null> {
    const [r] = await this.db
      .select({
        id: usersTable.id,
        address: usersTable.address,
        isOwner: usersTable.isOwner,
        tokenVersion: usersTable.tokenVersion,
      })
      .from(usersTable)
      .innerJoin(authSessions, eq(authSessions.userId, usersTable.id))
      .where(
        and(
          eq(usersTable.id, id),
          eq(authSessions.jti, jti),
          gt(authSessions.expiresAt, Date.now()),
        ),
      )
      .limit(1);
    return r
      ? { id: r.id, address: r.address, isOwner: r.isOwner, tokenVersion: r.tokenVersion }
      : null;
  }

  async resetPassword(id: string, passwordHash: string): Promise<void> {
    // Bump tokenVersion in the same statement → every JWT minted before the reset becomes invalid.
    await this.db
      .update(usersTable)
      .set({ passwordHash, tokenVersion: sql`${usersTable.tokenVersion} + 1` })
      .where(eq(usersTable.id, id));
  }

  // ── Whitelist (owner-managed registration gate) ──────────────────────────────────────────────
  async isWhitelisted(address: string): Promise<boolean> {
    const [r] = await this.db
      .select({ a: walletWhitelist.address })
      .from(walletWhitelist)
      .where(eq(walletWhitelist.address, address))
      .limit(1);
    return Boolean(r);
  }

  async listWhitelist(): Promise<WhitelistEntry[]> {
    const rows = await this.db.select().from(walletWhitelist).orderBy(walletWhitelist.createdAt);
    return rows.map((r) => ({
      address: r.address,
      note: r.note,
      addedBy: r.addedBy,
      createdAt: r.createdAt,
    }));
  }

  async addWhitelist(p: { address: string; note?: string; addedBy?: string }): Promise<void> {
    await this.db
      .insert(walletWhitelist)
      .values({
        address: p.address,
        note: p.note ?? '',
        addedBy: p.addedBy ?? '',
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: walletWhitelist.address,
        set: { note: p.note ?? '', addedBy: p.addedBy ?? '' },
      });
  }

  async removeWhitelist(address: string): Promise<void> {
    await this.db.delete(walletWhitelist).where(eq(walletWhitelist.address, address));
  }

  // ── Signature nonces (single-use, short TTL, purpose-bound) ──────────────────────────────────
  async issueNonce(
    address: string,
    nonce: string,
    expiresAt: number,
    purpose: NoncePurpose,
  ): Promise<void> {
    // Opportunistically prune expired rows so the table never accumulates stale challenges.
    await this.db.delete(authNonces).where(lte(authNonces.expiresAt, Date.now()));
    await this.db.insert(authNonces).values({ nonce, address, expiresAt, purpose });
  }

  async consumeNonce(address: string, nonce: string, purpose: NoncePurpose): Promise<boolean> {
    // Atomic single-use: DELETE the row only if it matches address+nonce+purpose AND is unexpired,
    // reporting whether a row was actually removed. A returned row ⇒ valid & now consumed; none ⇒
    // invalid / wrong-purpose / expired / already used. The delete-with-guard makes a captured
    // signature un-replayable, and the purpose match stops a register challenge being used to reset.
    const deleted = await this.db
      .delete(authNonces)
      .where(
        and(
          eq(authNonces.nonce, nonce),
          eq(authNonces.address, address),
          eq(authNonces.purpose, purpose),
          gt(authNonces.expiresAt, Date.now()),
        ),
      )
      .returning({ nonce: authNonces.nonce });
    return deleted.length > 0;
  }

  // ── Session allowlist (one row per issued JWT jti) ───────────────────────────────────────────
  async createSession(jti: string, userId: string, expiresAt: number): Promise<void> {
    await this.db.delete(authSessions).where(lte(authSessions.expiresAt, Date.now())); // prune expired
    await this.db.insert(authSessions).values({ jti, userId, expiresAt });
  }

  async isSessionValid(jti: string): Promise<boolean> {
    const [r] = await this.db
      .select({ jti: authSessions.jti })
      .from(authSessions)
      .where(and(eq(authSessions.jti, jti), gt(authSessions.expiresAt, Date.now())))
      .limit(1);
    return Boolean(r);
  }

  async deleteSession(jti: string): Promise<void> {
    await this.db.delete(authSessions).where(eq(authSessions.jti, jti));
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.db.delete(authSessions).where(eq(authSessions.userId, userId));
  }

  // ── Admin: accounts ──────────────────────────────────────────────────────────────────────────
  async listAccounts(): Promise<AccountSummary[]> {
    const us = await this.db.select().from(usersTable).orderBy(usersTable.createdAt);
    const ws = await this.db.select({ userId: uww.userId, a: uww.walletAddress }).from(uww);
    const byUser = new Map<string, string[]>();
    for (const w of ws) {
      const arr = byUser.get(w.userId) ?? [];
      arr.push(w.a);
      byUser.set(w.userId, arr);
    }
    return us.map((u) => ({
      id: u.id,
      address: u.address,
      isOwner: u.isOwner,
      createdAt: u.createdAt,
      wallets: byUser.get(u.id) ?? [],
    }));
  }

  /** Delete an account + its watchlist + its sessions; returns the wallets left with no watcher (so the
   *  engine can stop LIVE monitoring them). The wallets' SHARED position/flow data is KEPT (keyed by
   *  address, not by account) — revoking an account is "as if they never had one", the cached data
   *  survives for whoever watches the wallet next. */
  async deleteAccount(id: string): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const watched = (
        await tx.select({ a: uww.walletAddress }).from(uww).where(eq(uww.userId, id))
      ).map((r) => r.a);
      await tx.delete(uww).where(eq(uww.userId, id));
      const orphans: string[] = [];
      for (const addr of watched) {
        const [r] = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(uww)
          .where(eq(uww.walletAddress, addr));
        if (Number(r?.c ?? 0) === 0) orphans.push(addr);
      }
      await tx.delete(authSessions).where(eq(authSessions.userId, id)); // revoke the account's sessions
      await tx.delete(usersTable).where(eq(usersTable.id, id));
      return orphans;
    });
  }

  /** Unified access view for the admin: every invited address (whitelist) + every registered account,
   *  merged by address. status='joined' when an account exists for that address, else 'invited'. */
  async listAccess(): Promise<AccessEntry[]> {
    const [whitelist, accounts] = await Promise.all([this.listWhitelist(), this.listAccounts()]);
    const byAddress = new Map(accounts.map((a) => [a.address, a]));
    const seen = new Set<string>();
    const out: AccessEntry[] = [];
    for (const w of whitelist) {
      const acct = byAddress.get(w.address);
      seen.add(w.address);
      out.push({
        address: w.address,
        status: acct ? 'joined' : 'invited',
        isOwner: acct?.isOwner ?? false,
        note: w.note,
        wallets: acct?.wallets ?? [],
        createdAt: acct?.createdAt ?? w.createdAt,
      });
    }
    // An account whose whitelist entry was (somehow) removed still surfaces so it stays manageable.
    for (const a of accounts) {
      if (seen.has(a.address)) continue;
      out.push({
        address: a.address,
        status: 'joined',
        isOwner: a.isOwner,
        note: '',
        wallets: a.wallets,
        createdAt: a.createdAt,
      });
    }
    return out.sort((x, y) => x.createdAt - y.createdAt);
  }

  /** Per monitored wallet (anyone's watchlist): watcher count + open/closed position counts + the last
   *  time its positions were synced. Powers the admin Wallets tab; the route layers on live ingest
   *  status. SHARED data, keyed purely by address (independent of any account). */
  async walletOverview(): Promise<WalletOverview[]> {
    const watchers = await this.db
      .select({ address: uww.walletAddress, c: sql<number>`count(*)::int` })
      .from(uww)
      .groupBy(uww.walletAddress);
    const stats = await this.db
      .select({
        wallet: positionsTable.wallet,
        open: sql<number>`count(*) filter (where ${positionsTable.status} = 'open')::int`,
        closed: sql<number>`count(*) filter (where ${positionsTable.status} = 'closed')::int`,
        lastUpdate: sql<number | null>`max(${positionsTable.updatedAt})`,
      })
      .from(positionsTable)
      .groupBy(positionsTable.wallet);
    const byWallet = new Map(stats.map((s) => [s.wallet, s]));
    return watchers
      .map((w) => {
        const s = byWallet.get(w.address);
        return {
          address: w.address,
          watchers: Number(w.c),
          openPositions: Number(s?.open ?? 0),
          closedPositions: Number(s?.closed ?? 0),
          lastUpdate: s?.lastUpdate == null ? null : Number(s.lastUpdate),
        };
      })
      .sort((a, b) => b.watchers - a.watchers || a.address.localeCompare(b.address));
  }

  // ── Per-account watchlists ───────────────────────────────────────────────────────────────────
  async monitoredWallets(): Promise<string[]> {
    const rows = await this.db.selectDistinct({ a: uww.walletAddress }).from(uww);
    return rows.map((r) => r.a);
  }

  async watchedBy(userId: string) {
    const rows = await this.db
      .select()
      .from(uww)
      .where(eq(uww.userId, userId))
      .orderBy(uww.createdAt);
    return rows.map((r) => ({
      address: r.walletAddress,
      label: r.label,
      color: r.color ?? undefined,
      createdAt: r.createdAt,
    }));
  }

  async watchedAddresses(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ a: uww.walletAddress })
      .from(uww)
      .where(eq(uww.userId, userId));
    return rows.map((r) => r.a);
  }

  async countWatched(userId: string): Promise<number> {
    const [r] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(uww)
      .where(eq(uww.userId, userId));
    return Number(r?.c ?? 0);
  }

  async isWatching(userId: string, address: string): Promise<boolean> {
    const [r] = await this.db
      .select({ a: uww.walletAddress })
      .from(uww)
      .where(and(eq(uww.userId, userId), eq(uww.walletAddress, address)))
      .limit(1);
    return Boolean(r);
  }

  async addWatch(
    userId: string,
    w: { address: string; label?: string; color?: string },
  ): Promise<void> {
    await this.db
      .insert(uww)
      .values({
        userId,
        walletAddress: w.address,
        label: w.label ?? '',
        color: w.color ?? null,
        createdAt: Date.now(),
      })
      .onConflictDoNothing();
  }

  async removeWatch(userId: string, address: string): Promise<number> {
    // Drop this user's watch and report the wallet's remaining watcher count. The wallet's SHARED
    // position/flow data is intentionally KEPT even when the count reaches 0 — it's keyed by address,
    // not by account, so re-adding the wallet later is instant (no re-download) and never duplicated.
    // The caller stops LIVE monitoring when the count is 0; the cached data simply lingers.
    return this.db.transaction(async (tx) => {
      await tx.delete(uww).where(and(eq(uww.userId, userId), eq(uww.walletAddress, address)));
      const [r] = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(uww)
        .where(eq(uww.walletAddress, address));
      return Number(r?.c ?? 0);
    });
  }
}
