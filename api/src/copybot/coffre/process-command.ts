/**
 * Copy-bot · VAULT critical section (extracted from coffre-main so it is UNIT-TESTABLE in isolation — no top-level
 * side effects, all I/O injected via Ctx). Applies the ordered checks 5→13 BEFORE any signature:
 *  5 Zod strict · 6 staleness (slot ≤ deadline) · 7 commandId == derive(eventKey) · 8 idempotence (claim BEFORE
 *  signing; only a 'failed' command is re-claimable) · 9 re-clamp size (local config) · 10-11 Wall B (decode WITHOUT
 *  the SDK) · 12 SIGN · 13 LAND + CONFIRM. A returned signature is NOT execution: we confirm on-chain before marking
 *  'landed'/publishing ev:executed, so a dropped/erroring CLOSE is never recorded as success (which would strand it
 *  as a dormant position — only 'failed' is re-claimable, and a premature ev:executed makes the brain forget it).
 */
import { utils } from '@coral-xyz/anchor';
import { type Connection, type Keypair, Transaction } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { deriveCommandId } from '@/copybot/command-id';
import { claimExecution } from '@/copybot/coffre/idempotency';
import { confirmLanded, land } from '@/copybot/coffre/landing';
import { landViaJito } from '@/copybot/coffre/jito-landing';
import { verifyTx } from '@/copybot/coffre/wall-b';
import { derivePositionKeypair } from '@/copybot/ephemeral-position';
import type { CopyEvents } from '@/copybot/observability/copy-events';
import { SignRequestSchema } from '@/domain/copybot/contracts';
import { type CopyCode, resolveLegacyReason } from '@/domain/copybot/observability/codes';
import type { RedisBus } from '@/infrastructure/bus/redis-bus';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { executions } from '@/infrastructure/persistence/schema';
import type { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';

type Db = ReturnType<typeof openDatabase>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LAMPORTS_PER_SOL = 1_000_000_000;
// Wall B SOL-spend ceiling = maxTradeSol × factor + margin. GENEROUS by design (covers a buy's slippage + the WSOL
// ATA rent ~0.00204 SOL) so it NEVER false-rejects a legitimate deposit/buy — it only catches a GROSS over-spend
// (a compromised brain moving far more SOL than the config allows, regardless of the self-reported sizeSol).
const WALL_B_OVERSPEND_FACTOR = 1.1;
const WALL_B_RENT_MARGIN_LAMPORTS = 5_000_000; // 0.005 SOL: WSOL-ATA rent + buffer
const wallBMaxLamports = (maxTradeSol: number): number => Math.ceil(maxTradeSol * LAMPORTS_PER_SOL * WALL_B_OVERSPEND_FACTOR) + WALL_B_RENT_MARGIN_LAMPORTS;

/** Everything the critical section needs — all injected so the function has no hidden module state (testable). */
export interface Ctx {
  conn: Connection;
  db: Db;
  bus: RedisBus;
  copier: Keypair;
  blockhashCache: BlockhashCache;
  events: CopyEvents; // typed observability emitter (replaces the legacy Journal port — P2)
  maxTradeSol: number; // live re-clamp ceiling (DB config, env override) snapshotted per message
  jitoBundleUrl?: string; // when set, land via a Jito bundle (anti-sandwich) with a fallback to plain RPC
  signingEnabled: boolean; // false ⇒ dry-run (log "I would sign")
  hmacKey: string; // ev:executed envelope key
  retryMax: number; // sign+land attempts when land THROWS (no signature produced)
  retryDelayMs: number;
  confirmTimeoutMs: number; // how long to wait for on-chain confirmation before treating a landing as failed
  log: Logger;
}

/**
 * Resolve a bare Wall B reason leaf (e.g. `signer_not_owner`, `program_not_allowed`) to its `wallb.<leaf>` code.
 * The legacy journaled reason is `wallb:<leaf>` — `resolveLegacyReason` knows the two aliased forms; the rest are
 * the unique `wallb.<leaf>` namespace leaf. Falls back to `wallb.program_not_allowed` only for a never-seen leaf
 * (all Wall B rejects are a program/signer/destination violation of the same FAILSAFE class). Pure.
 */
function resolveWallbCode(leaf: string): CopyCode {
  return resolveLegacyReason(`wallb:${leaf}`) ?? resolveLegacyReason(leaf) ?? 'wallb.program_not_allowed';
}

/** Persist the terminal state of a command (the idempotency record). */
export async function finalize<T extends { ok: boolean }>(db: Db, commandId: string, state: string, verdict: T): Promise<T> {
  await db.update(executions).set({ state, updatedAt: Date.now() }).where(eq(executions.commandId, commandId));
  return verdict;
}

/** The critical section 5→13 (1-4 done by the bus). Returns a loggable verdict. Effects = DB + log + (when enabled) sign/land. */
export async function process1(payload: unknown | null, ctx: Ctx, recovering = false): Promise<{ ok: boolean; reason?: string; kind?: string }> {
  const { conn, db, bus, copier, blockhashCache, events, maxTradeSol, jitoBundleUrl, log } = ctx;
  const ourOwner = copier.publicKey.toBase58();
  if (payload == null) return { ok: false, reason: 'bad_hmac_or_hop' }; // 1-4 failed (bus)
  const parsed = SignRequestSchema.safeParse(payload); // 5
  if (!parsed.success) return { ok: false, reason: 'bad_schema' };
  const sr = parsed.data;

  const slot = await conn.getSlot(); // 6 staleness
  if (slot > sr.deadlineSlot) return { ok: false, reason: 'stale', kind: sr.kind };

  if (sr.commandId !== deriveCommandId(sr.eventKey)) return { ok: false, reason: 'commandId_mismatch', kind: sr.kind }; // 7

  // 8 idempotency: claim BEFORE signing; only a previously 'failed' command may be re-claimed (retry). EXCEPTION: a
  // reconcile-driven failsafe/orphan CLOSE (eventKey action 'failsafe'/'orphan') is emitted only while the position
  // is PROVABLY still on-chain → it must retry regardless of a stale terminal state, or a phantom is stuck forever.
  const now = Date.now();
  const action = sr.eventKey.split(':')[2]; // `${leader}:${pool}:${action}:${id}` — leader/pool are base58 (no ':')
  const forceReclaim = sr.kind === 'close' && (action === 'failsafe' || action === 'orphan');
  const owned = await claimExecution(db, sr.commandId, sr.eventKey, sr.deadlineSlot, now, recovering, forceReclaim);
  if (!owned) return { ok: false, reason: 'duplicate', kind: sr.kind };

  if (sr.sizeSol > maxTradeSol) {
    events.emit('sign.over_max_trade', { stage: 'sign', outcome: 'rejected', reason: 'over_max_trade', kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, ourSizeSol: sr.sizeSol });
    return finalize(db, sr.commandId, 'failed', { ok: false, reason: 'over_max_trade', kind: sr.kind }); // 9 re-clamp
  }

  // 10-11 Wall B: decode the tx (WITHOUT the SDK) and re-verify against the intent.
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(sr.txBase64, 'base64'));
  } catch {
    return finalize(db, sr.commandId, 'failed', { ok: false, reason: 'undecodable_tx', kind: sr.kind });
  }
  if (sr.owner !== ourOwner) return finalize(db, sr.commandId, 'failed', { ok: false, reason: 'owner_mismatch', kind: sr.kind });
  // Wall B binds a swap to owner's ATA of its non-SOL token: sell = the token sold, buy = the token bought.
  const wb = verifyTx(tx, { owner: sr.owner, pool: sr.pool, kind: sr.kind, positionPubkey: sr.positionPubkey, inputMint: sr.sell?.inputMint ?? sr.buy?.outputMint, maxLamports: wallBMaxLamports(maxTradeSol) });
  if (!wb.ok) {
    // Wall B reject → its precise `wallb.<leaf>` code. The verbatim journaled reason stays `wallb:<wb.reason>`
    // (a `program_not_allowed:<prog>` carries its dynamic `<prog>` into adminDetail, per SPEC §2.1). The leaf is
    // resolved from the bare wallb reason (the `:<prog>` suffix stripped) — all wallb leaves are internal.
    const leaf = wb.reason.split(':')[0] ?? wb.reason; // strip a dynamic `:${prog}` suffix (program_not_allowed)
    const code = resolveWallbCode(leaf);
    events.emit(code, { stage: 'sign', outcome: 'rejected', reason: `wallb:${wb.reason}`, kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, adminDetail: wb.reason.includes(':') ? { program: wb.reason.slice(wb.reason.indexOf(':') + 1) } : undefined });
    return finalize(db, sr.commandId, 'failed', { ok: false, reason: `wallb:${wb.reason}`, kind: sr.kind });
  }

  // 12-13 SIGN + LAND
  const busMs = Date.now() - sr.issuedAtMs; // latency publish(brain) → here (bus + critical section)
  if (!ctx.signingEnabled) {
    log.info({ kind: sr.kind, pool: sr.pool, our: sr.positionPubkey, sizeSol: sr.sizeSol, busMs }, '✍️  (dry-run) I would sign+land');
    return finalize(db, sr.commandId, 'skipped', { ok: true, reason: 'dry-run', kind: sr.kind });
  }
  // Retry config (fresh blockhash on each attempt), then ALERT "verify/close manually" (Valhalla-style).
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= ctx.retryMax; attempt++) {
    try {
      const tSign = Date.now();
      const fresh = Transaction.from(Buffer.from(sr.txBase64, 'base64')); // fresh tx per attempt
      // First attempt: cached blockhash (no RTT). Retries: fetch fresh in case the cached one went stale.
      const blockhash = attempt === 0 ? blockhashCache.get() : (await conn.getLatestBlockhash()).blockhash;
      fresh.feePayer = copier.publicKey;
      fresh.recentBlockhash = blockhash;
      const signers: Keypair[] = sr.kind === 'open' ? [copier, derivePositionKeypair(sr.commandId)] : [copier];
      fresh.sign(...signers);
      const raw = fresh.serialize();
      // Land via a Jito bundle when configured (anti-sandwich; falls back to plain RPC internally), else plain RPC.
      const sig = jitoBundleUrl ? await landViaJito(conn, jitoBundleUrl, raw, utils.bytes.bs58.encode(fresh.signature as Buffer)) : await land(conn, raw);
      // Tx ON THE WIRE — this is the CONTROLLABLE latency endpoint (event → submitted), the price-relevant moment.
      // Logged BEFORE the confirmation wait so latency tracking reflects submission speed, not chain-confirm time.
      log.info({ kind: sr.kind, sig, busMs, submitMs: Date.now() - tSign }, '🚀 submitted');
      // CONFIRM before declaring success: land()/landViaJito() return a SIGNATURE before the chain applies the tx
      // (sendRawTransaction skipPreflight / sendBundle). A close that drops or errors on-chain must NOT be recorded
      // 'landed' (only 'failed' is re-claimable, and a premature ev:executed makes the brain markClosed) — else it
      // becomes a permanent DORMANT position. confirmLanded returns false on an on-chain error OR a timeout.
      if (!(await confirmLanded(conn, sig, ctx.confirmTimeoutMs))) {
        // We hold a signature but no confirmation. Re-landing in place could DOUBLE-APPLY (a 2nd buy double-spends,
        // a 2nd add double-deposits), so do NOT retry: mark 'failed' (re-claimable) so the reconcile/orphan backstop
        // re-drives a CLOSE with a fresh commandId; a stuck open/buy ends 'failed' + alert, never a phantom success.
        lastErr = new Error(`landed_unconfirmed (sig ${sig})`);
        break;
      }
      // ev:executed carries the pool/position/owner so the brain can trigger the residual sell on a close.
      await bus.publish('copybot:ev:executed', 'ev:executed', ctx.hmacKey, { commandId: sr.commandId, kind: sr.kind, sig, pool: sr.pool, positionPubkey: sr.positionPubkey, owner: sr.owner });
      events.emit('sign.landed', { stage: 'sign', outcome: 'landed', kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, signature: sig, ourSizeSol: sr.sizeSol, latencyMs: Date.now() - sr.issuedAtMs, adminDetail: recovering ? { recovering: true } : undefined });
      log.info({ kind: sr.kind, sig, attempt, busMs, signLandMs: Date.now() - tSign, totalMs: Date.now() - sr.issuedAtMs }, '🚀 signed + landed (confirmed)');
      return finalize(db, sr.commandId, 'landed', { ok: true, kind: sr.kind });
    } catch (e) {
      lastErr = e as Error;
      log.warn({ kind: sr.kind, attempt, error: lastErr.message }, 'sign/land failed — retry');
      if (attempt < ctx.retryMax) await sleep(ctx.retryDelayMs);
    }
  }
  // Definitive failure (land threw after retries, OR landed-but-unconfirmed) → emergency. Two rows: the INTERNAL
  // sign trace (`sign.land_failed`) and the FEED-VISIBLE pinned lifecycle/failsafe alert the user must act on
  // ("VERIFY/CLOSE MANUALLY"). A close/open maps to its precise `lifecycle.*_failed` (risk of a dormant position);
  // any other kind to the generic pinned `failsafe.failed`. `meteoraUrl` carries the "close manually" link.
  // State 'failed' so the reconcile/orphan backstop re-drives it.
  const meteoraUrl = `https://app.meteora.ag/dlmm/${sr.pool}`;
  events.emit('sign.land_failed', { stage: 'sign', outcome: 'failed', reason: 'sign_land_failed', kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, adminDetail: { error: lastErr?.message } });
  const failCode: CopyCode = sr.kind === 'close' ? 'lifecycle.close_failed' : sr.kind === 'open' ? 'lifecycle.open_failed' : 'failsafe.failed';
  events.emit(failCode, { stage: 'sign', outcome: 'failed', reason: 'sign_land_failed', kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, adminDetail: { error: lastErr?.message, meteoraUrl, position: sr.positionPubkey } });
  return finalize(db, sr.commandId, 'failed', { ok: false, reason: 'sign_land_failed', kind: sr.kind });
}
