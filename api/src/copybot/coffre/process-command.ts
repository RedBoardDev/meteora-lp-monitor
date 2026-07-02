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
import { LOG_MARKER_SUBMITTED } from '@/copybot/log-markers';
import { derivePositionKeypair } from '@/copybot/ephemeral-position';
import type { CopyEvents } from '@/copybot/observability/copy-events';
import { type SignRequest, SignRequestSchema } from '@/domain/copybot/contracts';
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

/**
 * EXACTLY-ONCE (#7): persist the broadcast signature + its blockhash expiry to state 'submitted' BEFORE the tx goes
 * on the wire. If the vault crashes AFTER land() but BEFORE finalize('landed'), boot recovery reads this row and
 * checks the chain — re-signing only when the prior tx is PROVABLY dead (never double-broadcasting an add/buy/sell).
 */
export async function markSubmitted(db: Db, commandId: string, signature: string, lastValidBlockHeight: number, nowMs: number): Promise<void> {
  await db.update(executions).set({ state: 'submitted', signature, lastValidBlockHeight, updatedAt: nowMs }).where(eq(executions.commandId, commandId));
}

/** The fate of a previously-broadcast tx, decided from the chain (exactly-once recovery pre-check). */
type PriorTxFate = 'landed' | 'dead' | 'in-flight';

/**
 * Classify a previously-broadcast signature from the chain (exactly-once recovery):
 *  - a confirmed/finalized success → 'landed' (the money already moved; NEVER re-sign);
 *  - an on-chain error → 'dead' (Solana txs are atomic → the tx fully reverted, nothing applied → safe to re-sign);
 *  - not found (dropped or too-fresh-to-index) → 'dead' only once the blockhash is PROVABLY expired
 *    (`getBlockHeight > lastValidBlockHeight`), else 'in-flight' (it may still land → do NOT re-sign this pass);
 *  - found but only 'processed' (not yet durable) → 'in-flight'.
 */
export async function classifyPriorTx(conn: Connection, signature: string, lastValidBlockHeight: number): Promise<PriorTxFate> {
  const { value } = await conn.getSignatureStatus(signature);
  if (value) {
    if (value.err) return 'dead'; // atomically reverted → nothing applied
    if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') return 'landed';
    return 'in-flight'; // 'processed' only → not durable yet
  }
  // Not found: dropped (dead) vs. not-yet-indexed (in-flight) is disambiguated by the blockhash's expiry.
  const height = await conn.getBlockHeight('confirmed');
  return height > lastValidBlockHeight ? 'dead' : 'in-flight';
}

/**
 * Recovery pre-check (money-path exactly-once): for a command whose executions row already carries a BROADCAST
 * signature ('submitted', or a legacy 'claimed' that reached the wire), decide from the chain BEFORE re-signing:
 *  - 'landed' → finalize 'landed', re-publish ev:executed (idempotent downstream), and SKIP signing;
 *  - 'in-flight' → leave the message for a later recovery pass (retryLater: no ACK), do NOT re-sign;
 *  - 'dead' (or no stored signature) → return null → the caller proceeds to re-claim + re-sign normally.
 * Runs only on the vault boot/PEL recovery path. Not applied to forceReclaim (failsafe/orphan) closes, which keep
 * their existing always-retry semantics (a close re-sign is harmless — the account is either gone or gets re-closed).
 */
export async function recoveryPreCheck(ctx: Ctx, sr: SignRequest): Promise<{ ok: boolean; reason?: string; kind?: string; retryLater?: boolean } | null> {
  const { conn, db, bus, events, log } = ctx;
  const rows = await db
    .select({ state: executions.state, signature: executions.signature, lastValidBlockHeight: executions.lastValidBlockHeight })
    .from(executions)
    .where(eq(executions.commandId, sr.commandId));
  const prior = rows[0];
  // Nothing was broadcast (no row, no stored signature, or a terminal state) → safe to (re-)claim + sign normally.
  if (!prior?.signature || (prior.state !== 'submitted' && prior.state !== 'claimed')) return null;
  const fate = await classifyPriorTx(conn, prior.signature, prior.lastValidBlockHeight ?? 0);
  if (fate === 'in-flight') return { ok: false, reason: 'recover_in_flight', kind: sr.kind, retryLater: true };
  if (fate === 'dead') return null; // provably dead → fall through to re-claim + re-sign
  // 'landed': the money already moved. Re-publish ev:executed (idempotent downstream) and finalize — never re-sign.
  try {
    await bus.publish('copybot:ev:executed', 'ev:executed', ctx.hmacKey, { commandId: sr.commandId, kind: sr.kind, sig: prior.signature, pool: sr.pool, positionPubkey: sr.positionPubkey, owner: sr.owner });
  } catch (e) {
    log.error({ kind: sr.kind, sig: prior.signature, error: (e as Error).message }, 'ev:executed re-publish failed during recovery — brain will backstop via reconcile/PEL');
  }
  events.emit('sign.landed', { stage: 'sign', outcome: 'landed', kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, signature: prior.signature, ourSizeSol: sr.sizeSol, latencyMs: Date.now() - sr.issuedAtMs, adminDetail: { recovering: true, recovered: true } });
  log.info({ kind: sr.kind, sig: prior.signature }, '🔁 recovery: prior tx already landed — finalized without re-signing');
  return finalize(db, sr.commandId, 'landed', { ok: true, kind: sr.kind });
}

/** The critical section 5→13 (1-4 done by the bus). Returns a loggable verdict. Effects = DB + log + (when enabled) sign/land. */
export async function process1(payload: unknown | null, ctx: Ctx, recovering = false): Promise<{ ok: boolean; reason?: string; kind?: string; retryLater?: boolean }> {
  const { conn, db, bus, copier, blockhashCache, events, maxTradeSol, jitoBundleUrl, log } = ctx;
  const ourOwner = copier.publicKey.toBase58();
  if (payload == null) return { ok: false, reason: 'bad_hmac_or_hop' }; // 1-4 failed (bus)
  const parsed = SignRequestSchema.safeParse(payload); // 5
  if (!parsed.success) return { ok: false, reason: 'bad_schema' };
  const sr = parsed.data;

  const action = sr.eventKey.split(':')[2]; // `${leader}:${pool}:${action}:${id}` — leader/pool are base58 (no ':')
  const forceReclaim = sr.kind === 'close' && (action === 'failsafe' || action === 'orphan');

  // EXACTLY-ONCE recovery pre-check (#7) — BEFORE staleness/claim: a prior instance may have crashed after putting
  // the tx on the wire (state 'submitted') but before finalize('landed'). We check the chain FIRST (a landed tx is
  // landed regardless of the deadline) and re-sign ONLY a provably-dead tx. Skipped for forceReclaim closes (keep
  // their always-retry semantics — a close re-sign is harmless). null ⇒ nothing broadcast / dead → proceed normally.
  if (recovering && !forceReclaim) {
    const pre = await recoveryPreCheck(ctx, sr);
    if (pre) return pre;
  }

  const slot = await conn.getSlot(); // 6 staleness
  if (slot > sr.deadlineSlot) return { ok: false, reason: 'stale', kind: sr.kind };

  if (sr.commandId !== deriveCommandId(sr.eventKey)) return { ok: false, reason: 'commandId_mismatch', kind: sr.kind }; // 7

  // 8 idempotency: claim BEFORE signing; only a previously 'failed' command may be re-claimed (retry). EXCEPTION: a
  // reconcile-driven failsafe/orphan CLOSE (eventKey action 'failsafe'/'orphan') is emitted only while the position
  // is PROVABLY still on-chain → it must retry regardless of a stale terminal state, or a phantom is stuck forever.
  const now = Date.now();
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
  // Once confirmLanded returns true the on-chain action is IRREVERSIBLE and TERMINAL. We record the confirmed
  // signature here and break out of the retry scope: the post-confirm side effects (publish/emit/finalize) run
  // BELOW, OUTSIDE the try, so a Redis/DB blip there can never re-enter sign/land (which would DOUBLE-execute — a
  // 2nd add/buy/sell/remove has no on-chain idempotency). `landedAttempt`/`landedTSign` preserve the confirmed
  // attempt's values for the unchanged confirmed-land log payload.
  let landedSig: string | undefined;
  let landedAttempt = 0;
  let landedTSign = 0;
  for (let attempt = 0; attempt <= ctx.retryMax; attempt++) {
    try {
      const tSign = Date.now();
      const fresh = Transaction.from(Buffer.from(sr.txBase64, 'base64')); // fresh tx per attempt
      // First attempt: cached blockhash + expiry (no RTT). Retries: fetch fresh in case the cached one went stale.
      const bh = attempt === 0 ? blockhashCache.get() : await conn.getLatestBlockhash();
      fresh.feePayer = copier.publicKey;
      fresh.recentBlockhash = bh.blockhash;
      const signers: Keypair[] = sr.kind === 'open' ? [copier, derivePositionKeypair(sr.commandId)] : [copier];
      fresh.sign(...signers);
      const sig = utils.bytes.bs58.encode(fresh.signature as Buffer); // deterministic once signed (== land()'s return)
      // EXACTLY-ONCE (#7): persist signature + blockhash expiry to 'submitted' BEFORE broadcasting. A crash after
      // land() but before finalize('landed') is then recoverable — boot recovery re-signs ONLY a provably-dead tx.
      await markSubmitted(db, sr.commandId, sig, bh.lastValidBlockHeight, Date.now());
      const raw = fresh.serialize();
      // Land via a Jito bundle when configured (anti-sandwich; falls back to plain RPC internally), else plain RPC.
      if (jitoBundleUrl) await landViaJito(conn, jitoBundleUrl, raw, sig);
      else await land(conn, raw);
      // Tx ON THE WIRE — this is the CONTROLLABLE latency endpoint (event → submitted), the price-relevant moment.
      // Logged BEFORE the confirmation wait so latency tracking reflects submission speed, not chain-confirm time.
      log.info({ kind: sr.kind, sig, busMs, submitMs: Date.now() - tSign }, LOG_MARKER_SUBMITTED);
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
      // Confirmed → TERMINAL. Record it and LEAVE the retry scope; the post-confirm work runs below where a failure
      // can no longer re-sign/re-land. Nothing that can throw (publish/finalize) runs inside the try after this.
      landedSig = sig;
      landedAttempt = attempt;
      landedTSign = tSign;
      break;
    } catch (e) {
      lastErr = e as Error;
      log.warn({ kind: sr.kind, attempt, error: lastErr.message }, 'sign/land failed — retry');
      if (attempt < ctx.retryMax) await sleep(ctx.retryDelayMs);
    }
  }

  if (landedSig) {
    // TERMINAL success — the on-chain action already applied. Everything here runs OUTSIDE the retry scope so no
    // failure can trigger a re-sign/re-land (double execution). ev:executed carries the pool/position/owner so the
    // brain can trigger the residual sell on a close.
    try {
      await bus.publish('copybot:ev:executed', 'ev:executed', ctx.hmacKey, { commandId: sr.commandId, kind: sr.kind, sig: landedSig, pool: sr.pool, positionPubkey: sr.positionPubkey, owner: sr.owner });
    } catch (e) {
      // A lost ev:executed AFTER a confirmed land is a degraded (reconcile/PEL-backstopped) outcome — strictly better
      // than re-signing, which would DOUBLE-land. ioredis already retries connection blips; do NOT rethrow.
      log.error({ kind: sr.kind, sig: landedSig, error: (e as Error).message }, 'ev:executed publish failed after a confirmed land — brain will backstop via reconcile/PEL');
    }
    events.emit('sign.landed', { stage: 'sign', outcome: 'landed', kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, signature: landedSig, ourSizeSol: sr.sizeSol, latencyMs: Date.now() - sr.issuedAtMs, adminDetail: recovering ? { recovering: true } : undefined });
    log.info({ kind: sr.kind, sig: landedSig, attempt: landedAttempt, busMs, signLandMs: Date.now() - landedTSign, totalMs: Date.now() - sr.issuedAtMs }, '🚀 signed + landed (confirmed)');
    return finalize(db, sr.commandId, 'landed', { ok: true, kind: sr.kind });
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
