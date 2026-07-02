import { DLMM_PROGRAM_ID } from '@binsight/shared';
import { type Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { eq, inArray } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { deriveCommandId } from '@/copybot/command-id';
import { derivePositionKeypair } from '@/copybot/ephemeral-position';
import type { CopyEvents } from '@/copybot/observability/copy-events';
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
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }),
    getBlockHeight: async () => 500,
    sendRawTransaction: async () => `SIG_${Math.floor(Math.random() * 1e9)}`,
    getSignatureStatus: async () => status(),
  } as unknown as Connection;
}
const blockhashCache = { get: () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }) } as unknown as BlockhashCache;
// Typed observability emitter (P2): process1 emits codes through `events.emit`. A no-op fake here keeps the test
// focused on the verdict + the executions idempotency state (the observability rows are covered by their own suites).
const events = { emit: () => {} } as unknown as CopyEvents;

function ctxFor(conn: Connection, bus: RedisBus): Ctx {
  return { conn, db, bus, copier, blockhashCache, events, maxTradeSol: 1.0, signingEnabled: true, hmacKey: 'k', retryMax: 0, retryDelayMs: 0, confirmTimeoutMs: 40, log };
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

describe('process1 — #3: a confirmed land is TERMINAL (a post-confirm failure never re-signs/re-lands)', () => {
  it('a post-confirm bus.publish failure does NOT re-sign/re-land (no double execution)', async () => {
    // WHY (the money-path bug): once confirmLanded returns true the on-chain action already applied and is
    // IRREVERSIBLE. If a post-confirm publish (a Redis blip) threw INSIDE the retry scope, the loop would re-sign
    // the SAME tx with a fresh blockhash and RE-LAND it — a real-money double add/buy/sell/remove (no on-chain
    // idempotency). retryMax=1 is required to expose the regression: the old code re-lands on the throw (land×2),
    // the fixed code records the confirmed sig, breaks, and publishes ONCE outside the loop (land×1).
    const bus = { publish: vi.fn(async () => { throw new Error('redis blip'); }) } as unknown as RedisBus;
    const land = vi.fn(async () => `SIG_${Math.floor(Math.random() * 1e9)}`); // one land == one sendRawTransaction
    const conn = {
      getSlot: async () => 200,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58() }),
      sendRawTransaction: land,
      getSignatureStatus: async () => ({ value: { confirmationStatus: 'confirmed' } }), // confirms on the 1st attempt
    } as unknown as Connection;
    const sr = closeReq();
    const verdict = await process1(sr, { ...ctxFor(conn, bus), retryMax: 1 });
    expect(land).toHaveBeenCalledTimes(1); // no double-land — FAILS on the old code (re-lands → 2)
    expect(verdict).toEqual({ ok: true, kind: 'close' }); // the on-chain action is terminal → still 'landed'
    expect(bus.publish).toHaveBeenCalledTimes(1); // attempted once; the failure is swallowed, never re-published
    const row = await db.select().from(executions).where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('landed');
  });

  // NOTE: a `finalize` throw after a confirmed land can't be exercised cleanly — `finalize` is a module-level import
  // (not injected) and shares the same `db` that `claimExecution` needs to SUCCEED first, so a db that throws only on
  // the terminal update would be brittle. The fix already runs finalize OUTSIDE the retry scope (its throw can only
  // propagate, never re-sign): the publish-throw test above covers the terminal-scope guarantee.
});

// --- OPEN with a WSOL wrap: exercises the position-signer path + the #3 Wall-B SOL-spend cap, END-TO-END in process1.
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const ownerWsolAta = (owner: PublicKey): PublicKey => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), WSOL.toBuffer()], ATA_PROGRAM)[0];

/** A valid OPEN that WRAPS `wrapLamports` SOL into the copier's WSOL ATA (the real capital deployed). The ephemeral
 *  position (derived from commandId, as the coffre will) is a required signer so Wall B's open check passes. */
function openReq(wrapLamports: number, sizeSol = 0.1): Record<string, unknown> {
  const eventKey = `test:${pool.toBase58()}:open:${copier.publicKey.toBase58()}:${usedCommandIds.length}:${process.hrtime.bigint()}`;
  const commandId = deriveCommandId(eventKey);
  usedCommandIds.push(commandId);
  const ephemeral = derivePositionKeypair(commandId).publicKey;
  const t = new Transaction();
  t.feePayer = copier.publicKey;
  t.recentBlockhash = Keypair.generate().publicKey.toBase58();
  t.add(
    new TransactionInstruction({
      programId: DLMM,
      keys: [
        { pubkey: copier.publicKey, isSigner: true, isWritable: true },
        { pubkey: ephemeral, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ],
      data: Buffer.alloc(0),
    }),
    SystemProgram.transfer({ fromPubkey: copier.publicKey, toPubkey: ownerWsolAta(copier.publicKey), lamports: wrapLamports }),
  );
  return {
    commandId,
    eventKey,
    kind: 'open',
    pool: pool.toBase58(),
    positionPubkey: ephemeral.toBase58(),
    owner: copier.publicKey.toBase58(),
    txBase64: t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    sizeSol,
    targetBinRange: { lower: -1, upper: 1 },
    issuedAtSlot: 100,
    deadlineSlot: 1_000_000,
    issuedAtMs: Date.now(),
  };
}

describe('process1 — OPEN: position-signer + the #3 Wall-B SOL-spend cap end-to-end', () => {
  it('an open whose wrap is UNDER the cap (sized at maxTradeSol) lands when confirmed', async () => {
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const sr = openReq(900_000_000, 0.9); // wrap 0.9 SOL ≤ cap (maxTradeSol 1.0 × 1.1 + 0.005)
    const verdict = await process1(sr, ctxFor(conn, bus));
    expect(verdict).toEqual({ ok: true, kind: 'open' });
    expect(bus.publish).toHaveBeenCalledTimes(1);
  });

  it('an open that UNDER-REPORTS sizeSol but WRAPS far more than the cap → rejected wallb:sol_spend_over_cap (no sign)', async () => {
    // WHY: the #3 fix — the re-clamp only bounds the self-reported sizeSol (0.1, under maxTradeSol so it passes the
    // size check); Wall B must catch that the tx actually wraps 5 SOL, far over the cap, and refuse to sign.
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const sr = openReq(5_000_000_000, 0.1); // reports 0.1 SOL but wraps 5 SOL
    const verdict = await process1(sr, ctxFor(conn, bus));
    expect(verdict).toMatchObject({ ok: false, reason: 'wallb:sol_spend_over_cap', kind: 'open' });
    expect(bus.publish).not.toHaveBeenCalled(); // never signed/landed
    const row = await db.select().from(executions).where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('failed');
  });
});

// --- BUY (Jupiter SOL→token, funds a two-sided open): validates the #4 fix — a buy that doesn't confirm must NOT
// publish ev:executed (else the dependent two-sided open builds tokenless and fails).
const JUP = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
function buyReq(confirmable: boolean, outputMint: PublicKey): Record<string, unknown> {
  const eventKey = `test:${pool.toBase58()}:buy:${copier.publicKey.toBase58()}:${usedCommandIds.length}:${process.hrtime.bigint()}`;
  const commandId = deriveCommandId(eventKey);
  usedCommandIds.push(commandId);
  const t = new Transaction();
  t.feePayer = copier.publicKey;
  t.recentBlockhash = Keypair.generate().publicKey.toBase58();
  t.add(
    new TransactionInstruction({
      programId: JUP,
      keys: [
        { pubkey: copier.publicKey, isSigner: true, isWritable: true },
        { pubkey: PublicKey.findProgramAddressSync([copier.publicKey.toBuffer(), TOKEN_PROGRAM.toBuffer(), outputMint.toBuffer()], ATA_PROGRAM)[0], isSigner: false, isWritable: true },
      ],
      data: Buffer.alloc(0),
    }),
  );
  return {
    commandId,
    eventKey,
    kind: 'buy',
    pool: pool.toBase58(),
    positionPubkey: copier.publicKey.toBase58(),
    owner: copier.publicKey.toBase58(),
    txBase64: t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    sizeSol: 0.1,
    targetBinRange: { lower: 0, upper: 0 },
    issuedAtSlot: 100,
    deadlineSlot: 1_000_000,
    issuedAtMs: Date.now(),
    buy: { outputMint: outputMint.toBase58(), exactOutAmountRaw: '1000', maxInLamports: '100000000' },
  };
}

describe('process1 — BUY confirm gate (#4: a non-confirmed buy never publishes ev:executed)', () => {
  it('a buy that CONFIRMS → landed + ev:executed (the dependent open may proceed)', async () => {
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: { confirmationStatus: 'confirmed' } }));
    const verdict = await process1(buyReq(true, Keypair.generate().publicKey), ctxFor(conn, bus));
    expect(verdict).toEqual({ ok: true, kind: 'buy' });
    expect(bus.publish).toHaveBeenCalledTimes(1);
  });

  it('a buy that does NOT confirm (timeout) → failed, NO ev:executed (no tokenless two-sided open downstream)', async () => {
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = fakeConn(() => ({ value: null })); // never confirms
    const sr = buyReq(false, Keypair.generate().publicKey);
    const verdict = await process1(sr, ctxFor(conn, bus));
    expect(verdict.ok).toBe(false);
    expect(bus.publish).not.toHaveBeenCalled();
  });
});

// --- #7 EXACTLY-ONCE money-path: persist the signature + blockhash expiry BEFORE broadcast, then on recovery only
// re-sign a PROVABLY-dead tx. Without this, a vault crash after land() but before finalize('landed') re-signs on boot
// → the first tx AND the recovery tx both confirm → a real-money DOUBLE add/buy/sell/remove (no on-chain idempotency).
const PRIOR_SIG = 'PriorBroadcastSignature111111111111111111111';
const LVBH = 1_000; // lastValidBlockHeight stored with the submitted tx

/** Seed an already-broadcast executions row (state 'submitted' with a signature+expiry) as a crashed prior attempt. */
async function seedSubmitted(sr: Record<string, unknown>, signature: string | null, lastValidBlockHeight: number): Promise<void> {
  await db.insert(executions).values({ commandId: sr.commandId as string, eventKey: sr.eventKey as string, state: signature ? 'submitted' : 'claimed', deadlineSlot: 1_000_000, signature, lastValidBlockHeight, createdAt: Date.now(), updatedAt: Date.now() });
}

/** A conn whose getSignatureStatus/getBlockHeight are stubbed to drive the recovery pre-check outcome. */
function recoveryConn(opts: { priorStatus: Status; blockHeight: number; land: (raw: unknown) => Promise<string> }): Connection {
  return {
    getSlot: async () => 200,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: LVBH }),
    getBlockHeight: async () => opts.blockHeight,
    // The seeded PRIOR_SIG is classified per opts.priorStatus; any OTHER (freshly re-signed) sig confirms so a
    // legitimately-dead retry can complete.
    getSignatureStatus: async (s: string) => (s === PRIOR_SIG ? opts.priorStatus : ({ value: { confirmationStatus: 'confirmed' } } as Status)),
    sendRawTransaction: opts.land,
  } as unknown as Connection;
}

describe('process1 — #7: markSubmitted persists sig+expiry BEFORE the tx hits the wire', () => {
  it('the executions row is already "submitted" with signature+lastValidBlockHeight when land() is called', async () => {
    // WHY (the money-path bug): the crash-recoverable state (signature + blockhash expiry) MUST exist on-chain-side
    // BEFORE the tx is broadcast — otherwise a crash between land() and finalize() leaves recovery blind and it
    // re-broadcasts. We observe the DB row at the exact moment sendRawTransaction fires.
    const sr = closeReq();
    let stateAtLand: string | undefined;
    let sigAtLand: string | null | undefined;
    let lvbhAtLand: number | null | undefined;
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const conn = {
      getSlot: async () => 200,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: LVBH }),
      getBlockHeight: async () => 500,
      getSignatureStatus: async () => ({ value: { confirmationStatus: 'confirmed' } }),
      sendRawTransaction: async () => {
        const row = (await db.select().from(executions).where(eq(executions.commandId, sr.commandId as string)))[0];
        stateAtLand = row?.state;
        sigAtLand = row?.signature;
        lvbhAtLand = row?.lastValidBlockHeight;
        return `SIG_${Math.floor(Math.random() * 1e9)}`;
      },
    } as unknown as Connection;
    const verdict = await process1(sr, ctxFor(conn, bus));
    expect(verdict.ok).toBe(true);
    expect(stateAtLand).toBe('submitted'); // markSubmitted ran BEFORE land
    expect(sigAtLand).toBeTruthy();
    expect(lvbhAtLand).toBe(LVBH);
  });
});

describe('process1 — #7: recovery pre-check re-signs ONLY a provably-dead tx (exactly-once)', () => {
  it('case 1 (LANDED): a submitted row whose sig is confirmed → finalize landed + publish, NEVER re-signs', async () => {
    // WHY: this is the double-execution guard. The prior tx already confirmed (money moved). Boot recovery MUST NOT
    // re-broadcast. Against the pre-#7 code (recovering re-claims a stranded row and re-signs) `land` is called → a
    // double add/buy. With the fix the on-chain check sees 'confirmed' and finalizes without signing.
    const sr = closeReq();
    await seedSubmitted(sr, PRIOR_SIG, LVBH);
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const land = vi.fn(async () => 'SHOULD_NOT_BE_CALLED');
    const conn = recoveryConn({ priorStatus: { value: { confirmationStatus: 'confirmed' } }, blockHeight: 500, land });
    const verdict = await process1(sr, ctxFor(conn, bus), true); // recovering
    expect(land).not.toHaveBeenCalled(); // ← FAILS on the pre-#7 code (it re-signs the landed tx)
    expect(verdict).toEqual({ ok: true, kind: 'close' });
    expect(bus.publish).toHaveBeenCalledTimes(1); // ev:executed re-published (idempotent downstream)
    const row = await db.select().from(executions).where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('landed');
  });

  it('case 2 (DEAD): sig not found + blockhash expired (getBlockHeight > lastValidBlockHeight) → re-signs exactly once', async () => {
    // WHY: a tx whose blockhash has expired and that the chain has never seen is provably dead — the copy would be
    // MISSED if we did not re-drive it. The recovery re-signs and lands EXACTLY one new tx.
    const sr = closeReq();
    await seedSubmitted(sr, PRIOR_SIG, LVBH);
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const land = vi.fn(async () => `SIG_${Math.floor(Math.random() * 1e9)}`);
    const conn = recoveryConn({ priorStatus: { value: null }, blockHeight: LVBH + 1_000, land }); // not found + expired
    const verdict = await process1(sr, ctxFor(conn, bus), true);
    expect(land).toHaveBeenCalledTimes(1); // one — and only one — new land
    expect(verdict).toEqual({ ok: true, kind: 'close' });
    const row = await db.select().from(executions).where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('landed');
  });

  it('case 3 (IN-FLIGHT): sig not found but blockhash still valid → does NOT re-sign this pass (retryLater, unACKed)', async () => {
    // WHY: the tx may still land under a live blockhash. Re-signing now risks a double execution; ACKing now would
    // strand it. We leave it for a later recovery pass (retryLater → the loop does not ACK).
    const sr = closeReq();
    await seedSubmitted(sr, PRIOR_SIG, LVBH);
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const land = vi.fn(async () => 'SHOULD_NOT_BE_CALLED');
    const conn = recoveryConn({ priorStatus: { value: null }, blockHeight: LVBH - 100, land }); // not found + still valid
    const verdict = await process1(sr, ctxFor(conn, bus), true);
    expect(land).not.toHaveBeenCalled(); // no re-sign while the blockhash lives
    expect(verdict).toMatchObject({ ok: false, reason: 'recover_in_flight', retryLater: true });
    expect(bus.publish).not.toHaveBeenCalled();
    const row = await db.select().from(executions).where(eq(executions.commandId, sr.commandId as string));
    expect(row[0]?.state).toBe('submitted'); // untouched — awaits a later pass
  });

  it("a 'claimed' row with NO signature (crashed BEFORE broadcast) → nothing landed → re-signs safely", async () => {
    // WHY: markSubmitted had not run, so no tx ever hit the wire. Re-signing cannot double-execute.
    const sr = closeReq();
    await seedSubmitted(sr, null, 0); // signature null → state 'claimed'
    const bus = { publish: vi.fn(async () => 'sid') } as unknown as RedisBus;
    const land = vi.fn(async () => `SIG_${Math.floor(Math.random() * 1e9)}`);
    const conn = recoveryConn({ priorStatus: { value: null }, blockHeight: 500, land });
    const verdict = await process1(sr, ctxFor(conn, bus), true);
    expect(land).toHaveBeenCalledTimes(1); // safe re-sign (nothing was broadcast)
    expect(verdict).toEqual({ ok: true, kind: 'close' });
  });
});
