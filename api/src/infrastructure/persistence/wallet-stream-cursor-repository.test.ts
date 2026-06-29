import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import type { Database } from './database';
import * as schema from './schema';
import { WalletStreamCursorRepository } from './wallet-stream-cursor-repository';

async function newRepo(): Promise<WalletStreamCursorRepository> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  return new WalletStreamCursorRepository(db as unknown as Database);
}

describe('WalletStreamCursorRepository', () => {
  // WHY: this checkpoint is the no-miss backbone — a reconnect resumes from the persisted slot. An
  // unknown wallet has no checkpoint (null), and a set must round-trip BOTH signature and slot.
  it('round-trips the last signature + slot; unknown wallet is null', async () => {
    const repo = await newRepo();
    expect(await repo.get('w')).toBeNull();
    await repo.set('w', { lastSignature: 'sig1', lastSlot: 100 });
    expect(await repo.get('w')).toEqual({ lastSignature: 'sig1', lastSlot: 100 });
  });

  // WHY: the cursor only ever advances (last write wins), and the slot — which drives fromSlot replay —
  // must survive as a JS number even at a realistic mainnet magnitude, not be truncated or stringified.
  it('overwrites on a later set and persists a large slot as a number', async () => {
    const repo = await newRepo();
    await repo.set('w', { lastSignature: 'sig1', lastSlot: 100 });
    await repo.set('w', { lastSignature: 'sig2', lastSlot: 350_000_000 });
    const got = await repo.get('w');
    expect(got).toEqual({ lastSignature: 'sig2', lastSlot: 350_000_000 });
    expect(typeof got!.lastSlot).toBe('number'); // bigint mode:'number' → JS number, not a string
  });
});
