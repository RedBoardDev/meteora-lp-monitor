import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from './database';
import { PushRepository, type PushSub } from './push-repository';
import * as schema from './schema';

async function newRepo(): Promise<PushRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new PushRepository(db as unknown as Database);
}
const sub = (endpoint: string): PushSub => ({ endpoint, p256dh: 'p', auth: 'a' });
const endpoints = async (repo: PushRepository, userId: string) =>
  (await repo.forUser(userId)).map((s) => s.endpoint);

describe('PushRepository — subscription ownership', () => {
  it('save() does not let another user take over an existing endpoint (S14)', async () => {
    const repo = await newRepo();
    await repo.save('userA', sub('E'));
    await repo.save('userB', sub('E')); // takeover attempt on A's endpoint — must be a no-op
    expect(await endpoints(repo, 'userA')).toEqual(['E']);
    expect(await endpoints(repo, 'userB')).toEqual([]);
  });

  it('the owner can still refresh their own endpoint keys (idempotent re-subscribe)', async () => {
    const repo = await newRepo();
    await repo.save('userA', { endpoint: 'E', p256dh: 'p1', auth: 'a1' });
    await repo.save('userA', { endpoint: 'E', p256dh: 'p2', auth: 'a2' });
    expect(await repo.forUser('userA')).toEqual([{ endpoint: 'E', p256dh: 'p2', auth: 'a2' }]);
  });

  it('remove() only deletes the caller-owned subscription (S15)', async () => {
    const repo = await newRepo();
    await repo.save('userA', sub('E'));
    await repo.remove('userB', 'E'); // cross-user unsubscribe attempt — must be a no-op
    expect(await endpoints(repo, 'userA')).toEqual(['E']);
    await repo.remove('userA', 'E'); // owner removes their own — gone
    expect(await endpoints(repo, 'userA')).toEqual([]);
  });

  it('pruneEndpoint() removes a dead endpoint regardless of owner (404/410 path)', async () => {
    const repo = await newRepo();
    await repo.save('userA', sub('E'));
    await repo.pruneEndpoint('E');
    expect(await endpoints(repo, 'userA')).toEqual([]);
  });
});
