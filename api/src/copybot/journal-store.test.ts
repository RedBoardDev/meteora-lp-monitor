import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@/infrastructure/persistence/database';
import { copyJournal } from '@/infrastructure/persistence/schema';
import { CopyJournalStore } from './journal-store';

// Integration: requires local Postgres (:5435), like idempotency.test.ts.
const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const MARKER = '__test_journal_evt__'; // unique event_key so cleanup never touches real rows
const db = openDatabase(URL);
const noopLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
const clean = (): Promise<unknown> => db.delete(copyJournal).where(eq(copyJournal.eventKey, MARKER));

beforeAll(async () => {
  await clean();
});
afterAll(async () => {
  await clean();
});

describe('CopyJournalStore — persistence (integration)', () => {
  it('records an entry with the bound process, stamped ts, and all fields round-tripped', async () => {
    const store = new CopyJournalStore(db, noopLog, 'brain');
    await store.record({
      stage: 'open',
      outcome: 'published',
      kind: 'open',
      leader: 'LEADERxyz',
      pool: 'POOLabc',
      leaderPosition: 'LPOSdef',
      ourPosition: 'OURPOSghi',
      commandId: 'CMD1',
      eventKey: MARKER,
      leaderSizeSol: 1.5,
      ourSizeSol: 0.3,
      latencyMs: 1234,
      detail: { bins: 9, twoSided: true },
    });

    const rows = await db.select().from(copyJournal).where(eq(copyJournal.eventKey, MARKER));
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.process).toBe('brain'); // bound at construction, not passed per-call
    expect(r.stage).toBe('open');
    expect(r.outcome).toBe('published');
    expect(r.severity).toBe('info'); // defaulted from outcome
    expect(r.kind).toBe('open');
    expect(r.ourPosition).toBe('OURPOSghi');
    expect(r.leaderSizeSol).toBe(1.5);
    expect(r.latencyMs).toBe(1234);
    expect(r.detail).toEqual({ bins: 9, twoSided: true });
    expect(r.ts).toBeGreaterThan(0); // stamped by the adapter
  });

  it('defaults severity to error for a rejected vault command (alerting depends on it being persisted as error)', async () => {
    const store = new CopyJournalStore(db, noopLog, 'coffre');
    await store.record({ stage: 'sign', outcome: 'rejected', reason: 'wall_b_reject', eventKey: MARKER, commandId: 'CMD2' });

    const row = (await db.select().from(copyJournal).where(eq(copyJournal.commandId, 'CMD2')))[0]!;
    expect(row.process).toBe('coffre');
    expect(row.severity).toBe('error');
    expect(row.reason).toBe('wall_b_reject'); // producer's code stored verbatim
  });

  it('P1 shim: back-fills the new observability columns (code/wallet/correlation/category/audience) on every row', async () => {
    // WHY: P1's whole point is that every journaled row becomes attributable (WHERE wallet=$1) and code-tagged
    // BEFORE any call-site rewrite. A mapped reason resolves to its leaf; the bound wallet/userId back-fill.
    const store = new CopyJournalStore(db, noopLog, 'brain', 'COPYWALLET', 'tenant-1');
    await store.record({ stage: 'open', outcome: 'skipped', reason: 'below_min_market_cap', eventKey: MARKER, commandId: 'CMD4', pool: 'POOLx' });

    const row = (await db.select().from(copyJournal).where(eq(copyJournal.commandId, 'CMD4')))[0]!;
    expect(row.code).toBe('filter.below_min_market_cap'); // reason → leaf (resolveLegacyReason)
    expect(row.category).toBe('FILTER'); // denormalized from the resolved code
    expect(row.audience).toBe('feed');
    expect(row.wallet).toBe('COPYWALLET'); // bound per-instance (the filter key)
    expect(row.userId).toBe('tenant-1');
    expect(row.correlationId).toBe('CMD4'); // commandId ?? eventKey
    expect(row.reason).toBe('below_min_market_cap'); // verbatim reason still preserved
  });

  it('P1 shim: an unmapped reason back-fills the deterministic FALLBACK code (internal, never a fake feed alert)', async () => {
    const store = new CopyJournalStore(db, noopLog, 'coffre');
    await store.record({ stage: 'sweep', outcome: 'failed', reason: 'build_error', eventKey: MARKER, commandId: 'CMD5' });

    const row = (await db.select().from(copyJournal).where(eq(copyJournal.commandId, 'CMD5')))[0]!;
    expect(row.code).toBe('system.unmapped'); // no leaf → deterministic fallback
    expect(row.audience).toBe('internal'); // an unmapped reason never surfaces to the user
    expect(row.pinned).toBe(false);
    expect(row.severity).toBe('error'); // LEGACY severity governs in P1 (failed → error), NOT the fallback's 'warn'
    expect(row.reason).toBe('build_error'); // verbatim reason preserved for P2 migration
  });
});

describe('CopyJournalStore — clean stdout event line', () => {
  it('emits a clean info line for a normal event (the operator-facing feed)', async () => {
    const info = vi.fn();
    const log = { warn: vi.fn(), info, error: vi.fn() } as unknown as Logger;
    const store = new CopyJournalStore(db, log, 'brain');
    await store.record({ stage: 'open', outcome: 'published', kind: 'open', ourSizeSol: 0.3, eventKey: MARKER });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toContain('OPEN published');
  });

  it('emits at ERROR level for a rejected vault command, with the reason visible', async () => {
    // WHY: a vault rejection must be surfaced loudly on stdout with its cause, not buried at info.
    const error = vi.fn();
    const log = { warn: vi.fn(), info: vi.fn(), error } as unknown as Logger;
    const store = new CopyJournalStore(db, log, 'coffre');
    await store.record({ stage: 'sign', outcome: 'rejected', reason: 'wallb:foreign_sol_destination', eventKey: MARKER });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain('wallb:foreign_sol_destination');
  });
});

describe('CopyJournalStore — fail-safe (the cardinal guarantee)', () => {
  it('NEVER throws when the DB write fails — a journal hiccup must not break the hot path / cause a missed copy', async () => {
    // A db whose awaited insert rejects (DB down). The bot must keep running regardless.
    const brokenDb = { insert: () => ({ values: async () => { throw new Error('db down'); } }) } as unknown as ReturnType<typeof openDatabase>;
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const store = new CopyJournalStore(brokenDb, log, 'brain');

    await expect(store.record({ stage: 'close', outcome: 'published', kind: 'close' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1); // failed loudly...
    expect(warn.mock.calls[0]![1]).toContain('journal write failed'); // ...but swallowed the error
  });

  it('logs a loud warning when a reason-required entry has no reason, yet still records it (never drop activity)', async () => {
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    const store = new CopyJournalStore(db, log, 'brain');

    await store.record({ stage: 'open', outcome: 'skipped', eventKey: MARKER, commandId: 'CMD3' }); // reason MISSING
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toContain('missing a required reason');
    // still persisted despite the missing reason
    expect(await db.select().from(copyJournal).where(eq(copyJournal.commandId, 'CMD3'))).toHaveLength(1);
  });
});
