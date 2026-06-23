import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '@/infrastructure/http/auth';
import { PostgresAccountRepository } from './account-repository';
import type { Database } from './database';
import * as schema from './schema';
import { positions as positionsTable } from './schema';

async function setup() {
  const pg = drizzle(new PGlite(), { schema });
  await migrate(pg, { migrationsFolder: './drizzle' });
  const db = pg as unknown as Database;
  return { db, accounts: new PostgresAccountRepository(db) };
}

const mkUser = (address: string, isOwner = false) => ({
  address,
  passwordHash: hashPassword('correct horse battery'),
  isOwner,
});

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', () => {
    const h = hashPassword('correct horse battery');
    expect(verifyPassword('correct horse battery', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
});

describe('PostgresAccountRepository — tenancy', () => {
  it('isolates watchlists between users and unions the monitored set', async () => {
    const { accounts } = await setup();
    const a = await accounts.createUser(mkUser('AAAA'));
    const b = await accounts.createUser(mkUser('BBBB'));
    await accounts.addWatch(a.id, { address: 'W1' });
    await accounts.addWatch(a.id, { address: 'W2' });
    await accounts.addWatch(b.id, { address: 'W2' });
    expect((await accounts.watchedAddresses(a.id)).sort()).toEqual(['W1', 'W2']);
    expect(await accounts.watchedAddresses(b.id)).toEqual(['W2']);
    expect(await accounts.countWatched(a.id)).toBe(2);
    expect(await accounts.isWatching(a.id, 'W1')).toBe(true);
    expect(await accounts.isWatching(b.id, 'W1')).toBe(false); // B cannot see A's wallet
    expect((await accounts.monitoredWallets()).sort()).toEqual(['W1', 'W2']);
  });

  it('findByAddress / findById round-trip (with tokenVersion)', async () => {
    const { accounts } = await setup();
    const u = await accounts.createUser({
      address: 'CCCC',
      passwordHash: 'secret-hash',
      isOwner: false,
    });
    const byAddr = await accounts.findByAddress('CCCC');
    expect(byAddr?.user.id).toBe(u.id);
    expect(byAddr?.user.tokenVersion).toBe(0);
    expect(byAddr?.passwordHash).toBe('secret-hash');
    expect((await accounts.findById(u.id))?.address).toBe('CCCC');
    expect(await accounts.findByAddress('NOPE')).toBeNull();
  });

  it('removeWatch reports remaining watchers and KEEPS positions (shared cache) even when the last leaves', async () => {
    const { db, accounts } = await setup();
    const a = await accounts.createUser(mkUser('AAAA'));
    const b = await accounts.createUser(mkUser('BBBB'));
    await accounts.addWatch(a.id, { address: 'SHARED' });
    await accounts.addWatch(b.id, { address: 'SHARED' });
    await db.insert(positionsTable).values({
      positionAddress: 'P1',
      wallet: 'SHARED',
      poolAddress: 'pool',
      status: 'closed',
      updatedAt: Date.now(),
    });
    expect(await accounts.removeWatch(a.id, 'SHARED')).toBe(1); // B still watches it
    expect((await db.select().from(positionsTable)).length).toBe(1);
    expect(await accounts.removeWatch(b.id, 'SHARED')).toBe(0); // last watcher gone
    expect((await db.select().from(positionsTable)).length).toBe(1); // data KEPT, not evicted
  });
});

describe('PostgresAccountRepository — whitelist', () => {
  it('init seeds the owner address (idempotent) and gates registration', async () => {
    const { accounts } = await setup();
    expect(await accounts.isWhitelisted('OWNERADDR')).toBe(false);
    await accounts.init('OWNERADDR');
    await accounts.init('OWNERADDR'); // idempotent
    expect(await accounts.isWhitelisted('OWNERADDR')).toBe(true);
    expect((await accounts.listWhitelist()).map((w) => w.address)).toEqual(['OWNERADDR']);
  });

  it('init with an empty owner address seeds nothing', async () => {
    const { accounts } = await setup();
    await accounts.init('');
    expect(await accounts.listWhitelist()).toEqual([]);
  });

  it('adds, updates the note for, and removes whitelist entries', async () => {
    const { accounts } = await setup();
    await accounts.addWhitelist({ address: 'X', note: 'first', addedBy: 'owner' });
    await accounts.addWhitelist({ address: 'X', note: 'updated', addedBy: 'owner' }); // upsert note
    const list = await accounts.listWhitelist();
    expect(list).toHaveLength(1);
    expect(list[0]?.note).toBe('updated');
    await accounts.removeWhitelist('X');
    expect(await accounts.isWhitelisted('X')).toBe(false);
  });
});

describe('PostgresAccountRepository — signature nonces', () => {
  it('a nonce is single-use: it verifies once then never again', async () => {
    const { accounts } = await setup();
    await accounts.issueNonce('ADDR', 'n1', Date.now() + 60_000, 'register');
    expect(await accounts.consumeNonce('ADDR', 'n1', 'register')).toBe(true);
    expect(await accounts.consumeNonce('ADDR', 'n1', 'register')).toBe(false); // already consumed
  });

  it('rejects a nonce for the wrong address, purpose, unknown nonce, or expired one', async () => {
    const { accounts } = await setup();
    await accounts.issueNonce('ADDR', 'n1', Date.now() + 60_000, 'register');
    expect(await accounts.consumeNonce('OTHER', 'n1', 'register')).toBe(false); // address mismatch
    expect(await accounts.consumeNonce('ADDR', 'n1', 'reset')).toBe(false); // purpose mismatch
    expect(await accounts.consumeNonce('ADDR', 'nope', 'register')).toBe(false); // unknown nonce
    await accounts.issueNonce('ADDR', 'expired', Date.now() - 1000, 'register');
    expect(await accounts.consumeNonce('ADDR', 'expired', 'register')).toBe(false); // past TTL
  });
});

describe('PostgresAccountRepository — session allowlist', () => {
  it('a session is valid until deleted (real logout)', async () => {
    const { accounts } = await setup();
    await accounts.createSession('jti-1', 'user-1', Date.now() + 60_000);
    expect(await accounts.isSessionValid('jti-1')).toBe(true);
    await accounts.deleteSession('jti-1');
    expect(await accounts.isSessionValid('jti-1')).toBe(false); // logged out → token now rejected
  });

  it('an expired session is invalid', async () => {
    const { accounts } = await setup();
    await accounts.createSession('jti-old', 'user-1', Date.now() - 1000);
    expect(await accounts.isSessionValid('jti-old')).toBe(false);
  });

  it('findByIdWithSession returns the account only with a live session for that jti (O07)', async () => {
    const { accounts } = await setup();
    const u = await accounts.createUser({ address: 'WSESS', passwordHash: 'h', isOwner: false });
    await accounts.createSession('jti-x', u.id, Date.now() + 60_000);
    expect((await accounts.findByIdWithSession(u.id, 'jti-x'))?.id).toBe(u.id);
    expect(await accounts.findByIdWithSession(u.id, 'nope')).toBeNull(); // unknown jti
    await accounts.deleteSession('jti-x');
    expect(await accounts.findByIdWithSession(u.id, 'jti-x')).toBeNull(); // revoked → no account
  });

  it('deleteUserSessions revokes every session of a user (on password reset)', async () => {
    const { accounts } = await setup();
    await accounts.createSession('j1', 'user-1', Date.now() + 60_000);
    await accounts.createSession('j2', 'user-1', Date.now() + 60_000);
    await accounts.createSession('other', 'user-2', Date.now() + 60_000);
    await accounts.deleteUserSessions('user-1');
    expect(await accounts.isSessionValid('j1')).toBe(false);
    expect(await accounts.isSessionValid('j2')).toBe(false);
    expect(await accounts.isSessionValid('other')).toBe(true); // other users unaffected
  });
});

describe('PostgresAccountRepository — reset & admin', () => {
  it('resetPassword swaps the hash and bumps tokenVersion (kills old sessions)', async () => {
    const { accounts } = await setup();
    const u = await accounts.createUser(mkUser('AAAA'));
    expect(u.tokenVersion).toBe(0);
    await accounts.resetPassword(u.id, 'new-hash');
    const after = await accounts.findById(u.id);
    expect(after?.tokenVersion).toBe(1);
    expect((await accounts.findByAddress('AAAA'))?.passwordHash).toBe('new-hash');
  });

  it('listAccounts returns each account with its watched wallets', async () => {
    const { accounts } = await setup();
    const a = await accounts.createUser(mkUser('AAAA', true));
    await accounts.addWatch(a.id, { address: 'AAAA' });
    await accounts.addWatch(a.id, { address: 'W2' });
    const list = await accounts.listAccounts();
    expect(list).toHaveLength(1);
    expect(list[0]?.address).toBe('AAAA');
    expect(list[0]?.isOwner).toBe(true);
    expect([...(list[0]?.wallets ?? [])].sort()).toEqual(['AAAA', 'W2']);
  });

  it('deleteAccount returns orphans + revokes sessions but KEEPS all position data', async () => {
    const { db, accounts } = await setup();
    const a = await accounts.createUser(mkUser('AAAA'));
    const b = await accounts.createUser(mkUser('BBBB'));
    await accounts.addWatch(a.id, { address: 'SOLO' });
    await accounts.addWatch(a.id, { address: 'SHARED' });
    await accounts.addWatch(b.id, { address: 'SHARED' });
    await accounts.createSession('sess-a', a.id, Date.now() + 60_000);
    await db.insert(positionsTable).values([
      { positionAddress: 'P1', wallet: 'SOLO', poolAddress: 'p', status: 'closed', updatedAt: 1 },
      { positionAddress: 'P2', wallet: 'SHARED', poolAddress: 'p', status: 'closed', updatedAt: 1 },
    ]);
    const orphans = await accounts.deleteAccount(a.id);
    expect(orphans).toEqual(['SOLO']); // SHARED still watched by B → not orphan
    const remaining = (await db.select().from(positionsTable)).map((p) => p.wallet).sort();
    expect(remaining).toEqual(['SHARED', 'SOLO']); // ALL data kept (shared, not account-owned)
    expect(await accounts.isSessionValid('sess-a')).toBe(false); // the account's sessions are revoked
    expect(await accounts.findById(a.id)).toBeNull();
    expect(await accounts.findById(b.id)).not.toBeNull();
  });
});

describe('PostgresAccountRepository — admin views', () => {
  it('listAccess merges invited (whitelist) and joined (accounts) by address', async () => {
    const { accounts } = await setup();
    await accounts.addWhitelist({ address: 'PENDING', note: 'beta' }); // invited, no account
    const o = await accounts.createUser(mkUser('OWNERADDR', true));
    await accounts.addWhitelist({ address: 'OWNERADDR', note: 'owner' });
    await accounts.addWatch(o.id, { address: 'OWNERADDR' });
    const byAddr = new Map((await accounts.listAccess()).map((a) => [a.address, a]));
    expect(byAddr.get('OWNERADDR')?.status).toBe('joined');
    expect(byAddr.get('OWNERADDR')?.isOwner).toBe(true);
    expect(byAddr.get('OWNERADDR')?.wallets).toEqual(['OWNERADDR']);
    expect(byAddr.get('PENDING')?.status).toBe('invited');
    expect(byAddr.get('PENDING')?.note).toBe('beta');
  });

  it('walletOverview reports watchers + open/closed counts + last sync per wallet', async () => {
    const { db, accounts } = await setup();
    const a = await accounts.createUser(mkUser('AAAA'));
    const b = await accounts.createUser(mkUser('BBBB'));
    await accounts.addWatch(a.id, { address: 'W1' });
    await accounts.addWatch(b.id, { address: 'W1' }); // 2 watchers on W1
    await accounts.addWatch(a.id, { address: 'W2' });
    await db.insert(positionsTable).values([
      { positionAddress: 'p1', wallet: 'W1', poolAddress: 'p', status: 'open', updatedAt: 100 },
      { positionAddress: 'p2', wallet: 'W1', poolAddress: 'p', status: 'closed', updatedAt: 200 },
    ]);
    const ov = await accounts.walletOverview();
    const w1 = ov.find((w) => w.address === 'W1');
    expect(w1?.watchers).toBe(2);
    expect(w1?.openPositions).toBe(1);
    expect(w1?.closedPositions).toBe(1);
    expect(w1?.lastUpdate).toBe(200);
    const w2 = ov.find((w) => w.address === 'W2');
    expect(w2?.watchers).toBe(1);
    expect(w2?.openPositions).toBe(0);
    expect(w2?.lastUpdate).toBeNull();
  });
});
