import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { type Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { eq, inArray } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { deriveCommandId } from '@/copybot/command-id';
import type { Journal } from '@/domain/copybot/journal';
import type { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';
import type { RedisBus } from '@/infrastructure/bus/redis-bus';
import { openDatabase } from '@/infrastructure/persistence/database';
import { executions } from '@/infrastructure/persistence/schema';
import { type Ctx, process1 } from './process-command';

// Integration: requires local Postgres (:5435) for the executions idempotency table.
const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const db = openDatabase(URL);
const log = pino({ level: 'silent' });
const copier = Keypair.generate();
const DLMM = new PublicKey(DLMM_PROGRAM_ID);
const pool = Keypair.generate().publicKey;
const position = Keypair.generate().publicKey;
const usedCommandIds: string[] = [];

afterAll(async () => {
  if (usedCommandIds.length) await db.delete(executions).where(inArray(executions.commandId, usedCommandIds));
});

/** A close tx that PASSES Wall B: feePayer = owner (copier), a DLMM ix touching the pool + position, no foreign dest. */
function closeTxBase64(): string {
  const t = new Transaction();
  t.feePayer = copier.publicKey;
  t.recentBlockhash = Keypair.generate().publicKey.toBase58();
  t.add(
    new TransactionInstruction({
      programId: DLMM,
      keys: [
        { pubkey: copier.publicKey, isSigner: true, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ],
      data: Buffer.alloc(0),
    }),
  );
  return t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function closeReq(): Record<string, unknown> {
  const eventKey = `test:${pool.toBase58()}:close:${copier.publicKey.toBase58()}:${usedCommandIds.length}:${process.hrtime.bigint()}`;
  const commandId = deriveCommandId(eventKey);
  usedCommandIds.push(commandId);
  return {
    commandId,
    eventKey,
    kind: 'close',
    pool: pool.toBase58(),
    positionPubkey: position.toBase58(),
    owner: copier.publicKey.toBase58(),
    txBase64: closeTxBase64(),
    sizeSol: 0.1,
    targetBinRange: { lower: -1, upper: 1 },
    issuedAtSlot: 100,
    deadlineSlot: 1_000_000,
    issuedAtMs: Date.now(),
  };
}

type Status = { value: { err?: unknown; confirmationStatus?: string } | null };
function fakeConn(status: () => Status): Connection {
  return {
    getSlot: async () => 200,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58() }),
    sendRawTransaction: async () => `SIG_${Math.floor(Math.random() * 1e9)}`,
    getSignatureStatus: async () => status(),
  } as unknown as Connection;
}
const blockhashCache = { get: () => Keypair.generate().publicKey.toBase58() } as unknown as BlockhashCache;
const journal = { record: async () => {} } as unknown as Journal;

function ctxFor(conn: Connection, bus: RedisBus): Ctx {
  return { conn, db, bus, copier, blockhashCache, journal, maxTradeSol: 1.0, signingEnabled: true, hmacKey: 'k', retryMax: 0, retryDelayMs: 0, confirmTimeoutMs: 40, log };
}

describe('process1 — a returned signature is NOT execution (no dormant-position on a silently-failed close)', () => {
  it('CONFIRMED landing → ok=landed AND ev:executed published (the brain may now markClosed)', async () => {
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const sr = closeReq();
    const verdict = await process1(sr, ctxFor(conn, bus));
    expect(verdict).toEqual({ ok: true, kind: 'close' });
    expect(bus.publish).toHaveBeenCalledTimes(1);
    const row = await db.select().from(executions).where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('landed');
  });

  it('on-chain ERROR (tx returned a sig then failed) → ok=false, NO ev:executed, state=failed (re-claimable)', async () => {
    // WHY: the cardinal no-miss bug — a close that lands a signature but errors on-chain must NOT be recorded as
    // success. It stays 'failed' so the reconcile/orphan backstop re-drives it, and the brain never markCloses early.
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { err: 'InstructionError' } }));
    const sr = closeReq();
    const verdict = await process1(sr, ctxFor(conn, bus));
    expect(verdict.ok).toBe(false);
    expect(bus.publish).not.toHaveBeenCalled(); // no premature ev:executed → the brain keeps the mirror open
    const row = await db.select().from(executions).where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('failed'); // re-claimable by a reconcile retry
  });

  it('confirmation TIMEOUT (signature never confirms) → state=failed, NO ev:executed (not a phantom landed)', async () => {
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: null })); // never confirms → confirmLanded times out → false
    const sr = closeReq();
    const verdict = await process1(sr, ctxFor(conn, bus));
    expect(verdict.ok).toBe(false);
    expect(bus.publish).not.toHaveBeenCalled();
    const row = await db.select().from(executions).where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('failed');
  });

  it('a confirmed landing is then a DUPLICATE on replay (idempotency unchanged by the confirm step)', async () => {
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'finalized' } }));
    const sr = closeReq();
    expect((await process1(sr, ctxFor(conn, bus))).ok).toBe(true);
    const again = await process1(sr, ctxFor(conn, bus)); // same commandId, now 'landed' → not re-claimable
    expect(again).toMatchObject({ ok: false, reason: 'duplicate' });
  });

  it('dry-run (signing disabled) short-circuits to skipped (never reaches confirm)', async () => {
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { err: 'should-not-be-checked' } }));
    const sr = closeReq();
    const verdict = await process1(sr, { ...ctxFor(conn, bus), signingEnabled: false });
    expect(verdict).toMatchObject({ ok: true, reason: 'dry-run' });
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
