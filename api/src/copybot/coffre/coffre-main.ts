/**
 * Copy-bot · Inc.3 — VAULT process (zone Z3: the ONLY holder of the key, pull-only, NO inbound socket).
 * Consumes `cmd:sign` (XREADGROUP) and applies the ordered critical section BEFORE any signature:
 *  1-4 (bus) size/HMAC/hop · 5 Zod strict · 6 staleness (slot ≤ deadline) · 7 commandId == derive(eventKey)
 *  · 8 idempotence (INSERT executions ON CONFLICT, BEFORE) · 9 re-clamp size (local config) · 10-11 Wall B
 *  (decoding WITHOUT the SDK) · 12 SIGN · 13 LAND. In Inc.3, 12-13 = DRY-RUN (log "I would sign"), no
 *  signature. Does NOT import the DLMM SDK (firewall F3) → runs under tsx.
 *   node --import tsx --env-file=../.env src/copybot/coffre/coffre-main.ts
 */
import { Connection, type Keypair, Transaction } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { alert } from '@/copybot/alert';
import { CopyJournalStore } from '@/copybot/journal-store';
import { HeartbeatStore } from '@/copybot/heartbeat-store';
import { HEARTBEAT_INTERVAL_MS } from '@/domain/copybot/status';
import { deriveCommandId } from '@/copybot/command-id';
import { claimExecution } from '@/copybot/coffre/idempotency';
import { loadCopierKeypair } from '@/copybot/coffre/keypair';
import { confirmLanded, land } from '@/copybot/coffre/landing';
import { verifyTx } from '@/copybot/coffre/wall-b';
import { derivePositionKeypair } from '@/copybot/ephemeral-position';
import { ConfigStore } from '@/copybot/config-store';
import { SignRequestSchema } from '@/domain/copybot/contracts';
import type { Journal } from '@/domain/copybot/journal';
import { ControlChannel } from '@/infrastructure/bus/control-channel';
import { RedisBus } from '@/infrastructure/bus/redis-bus';
import { openDatabase } from '@/infrastructure/persistence/database';
import { executions } from '@/infrastructure/persistence/schema';
import { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';

const STREAM = 'copybot:cmd:sign';
const GROUP = 'coffre';
const CONSUMER = 'coffre-1';
const HOP = 'cmd:sign';
const CONFIG_POLL_MS = 5_000; // re-read the DB-backed runtime config (the maxTradeSol re-clamp ceiling) so web edits apply live

const cfg = {
  httpUrl: process.env.SOLANA_HTTP_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6385',
  dbUrl: process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora',
  hmacKey: process.env.BUS_HMAC_KEY ?? 'dev-k-sign-CHANGE-ME',
  keypairPath: process.env.COPIER_KEYPAIR_PATH ?? '.wallets/copier-test.json',
  owner: process.env.COPIER_OWNER ?? 'Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz',
  maxTradeSolEnv: process.env.MAX_TRADE_SOL !== undefined ? Number(process.env.MAX_TRADE_SOL) : undefined, // env override; else the DB config's maxTradeSizeSol
  signingEnabled: process.env.SIGNING_ENABLED === 'true', // Inc.4 ; false = dry-run
  retryMax: Number(process.env.SIGN_RETRY_MAX ?? '2'), // sign+land attempts before alerting (Valhalla-style)
  retryDelayMs: Number(process.env.SIGN_RETRY_DELAY_MS ?? '1500'),
};

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!cfg.httpUrl) {
    log.error('SOLANA_HTTP_URL missing');
    process.exit(1);
  }
  // THE-TRAP: the loaded key MUST be the expected copier wallet (fail-closed otherwise).
  const copier = loadCopierKeypair(cfg.keypairPath, cfg.owner);
  const conn = new Connection(cfg.httpUrl, 'confirmed');
  const db = openDatabase(cfg.dbUrl);
  const journal = new CopyJournalStore(db, log, 'coffre'); // activity journal (fail-safe; never blocks signing)
  const configStore = new ConfigStore(db, log);
  let runtimeConfig = await configStore.seedIfAbsent(); // DB-backed config; the maxTradeSol re-clamp ceiling is read live (env wins when set)
  const maxTradeSol = (): number => cfg.maxTradeSolEnv ?? runtimeConfig.sizing.maxTradeSizeSol;
  const reloadConfig = async (): Promise<void> => {
    runtimeConfig = await configStore.load();
  };
  const control = ControlChannel.connect(cfg.redisUrl); // instant config-reload pings (re-clamp ceiling in <100ms)
  const heartbeat = new HeartbeatStore(db, log, 'coffre'); // process status the web reads (vault online + signing state)
  const bus = RedisBus.connect(cfg.redisUrl);
  await bus.ensureGroup(STREAM, GROUP);
  const blockhashCache = new BlockhashCache(async () => (await conn.getLatestBlockhash()).blockhash);
  await blockhashCache.start(); // first sign attempt reads it instantly (no getLatestBlockhash RTT)
  log.info({ owner: copier.publicKey.toBase58(), signing: cfg.signingEnabled }, '🔐 vault started (pull-only)');

  // CRASH RECOVERY (no-miss): re-process any cmd:sign a prior (crashed) instance read but never ACKed — its PEL,
  // re-read with XREADGROUP id '0'. Exactly-once is guaranteed by the executions table (a landed command is a
  // duplicate; a stranded 'claimed' one is re-claimable). Without this, a vault crash mid-sign would STRAND an
  // in-flight open/close forever (XREADGROUP '>' never re-delivers it) → a missed copy.
  const recoverCtx: Ctx = { conn, db, bus, copier, blockhashCache, journal, maxTradeSol: maxTradeSol() };
  try {
    const pending = await bus.consumePending(STREAM, GROUP, CONSUMER, HOP, cfg.hmacKey, 100);
    for (const msg of pending) {
      const verdict = await process1(msg.payload, recoverCtx, true); // recovering → a stranded 'claimed' is re-claimable
      log.info({ id: msg.id, recovered: true, ...verdict }, '♻️  recovered pending');
      await bus.ack(STREAM, GROUP, msg.id);
    }
  } catch (e) {
    await alert(log, 'vault pending-recovery errored on boot', { error: (e as Error).message });
  }

  let stopped = false;
  const drain = process.argv.includes('--drain'); // one batch then exit (validation)
  // Live config reload. A web config edit publishes a control ping → reload from the DB NOW (re-clamp ceiling in
  // <100ms); the periodic poll is the backstop if a ping is missed.
  const configTimer = setInterval(() => void reloadConfig(), CONFIG_POLL_MS);
  await control.subscribe(() => {
    log.info('🔁 control: config-changed → reloading config now');
    void reloadConfig();
  });
  // Process heartbeat: beat now (web sees the vault online immediately) then on an interval.
  void heartbeat.beat({ signingEnabled: cfg.signingEnabled });
  const heartbeatTimer = setInterval(() => void heartbeat.beat({ signingEnabled: cfg.signingEnabled }), HEARTBEAT_INTERVAL_MS);
  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(configTimer);
    clearInterval(heartbeatTimer);
    blockhashCache.stop();
    await Promise.all([bus.quit(), control.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  let backoff = 1000;
  do {
    try {
      const msgs = await bus.consume(STREAM, GROUP, CONSUMER, HOP, cfg.hmacKey, 10, drain ? 3000 : 5000);
      for (const msg of msgs) {
        const verdict = await process1(msg.payload, { conn, db, bus, copier, blockhashCache, journal, maxTradeSol: maxTradeSol() });
        log.info({ id: msg.id, ...verdict }, verdict.ok ? '✅ processed' : '⛔ rejected');
        await bus.ack(STREAM, GROUP, msg.id); // ACK: idempotence guaranteed by the executions table
      }
      backoff = 1000; // success → reset
    } catch (e) {
      // never crash: alert + exponential backoff + continue (Redis/RPC may recover).
      await alert(log, 'vault loop errored (Redis/RPC?) — backoff', { error: (e as Error).message, backoff });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
    if (drain) break;
  } while (!stopped);
  if (drain) await stop();
}

/** The critical section 5→13 (1-4 done by the bus). Returns a loggable verdict. Free of effects except DB + log. */
interface Ctx {
  conn: Connection;
  db: ReturnType<typeof openDatabase>;
  bus: RedisBus;
  copier: Keypair;
  blockhashCache: BlockhashCache;
  journal: Journal;
  maxTradeSol: number; // live re-clamp ceiling (DB config, env override) snapshotted per message
}

async function process1(payload: unknown | null, ctx: Ctx, recovering = false): Promise<{ ok: boolean; reason?: string; kind?: string }> {
  const { conn, db, bus, copier, blockhashCache, journal, maxTradeSol } = ctx;
  const ourOwner = copier.publicKey.toBase58();
  if (payload == null) return { ok: false, reason: 'bad_hmac_or_hop' }; // 1-4 failed (bus)
  const parsed = SignRequestSchema.safeParse(payload); // 5
  if (!parsed.success) return { ok: false, reason: 'bad_schema' };
  const sr = parsed.data;

  const slot = await conn.getSlot(); // 6 staleness
  if (slot > sr.deadlineSlot) return { ok: false, reason: 'stale', kind: sr.kind };

  if (sr.commandId !== deriveCommandId(sr.eventKey)) return { ok: false, reason: 'commandId_mismatch', kind: sr.kind }; // 7

  // 8 idempotency: claim BEFORE signing; only a previously 'failed' command may be re-claimed (retry).
  const now = Date.now();
  const owned = await claimExecution(db, sr.commandId, sr.eventKey, sr.deadlineSlot, now, recovering);
  if (!owned) return { ok: false, reason: 'duplicate', kind: sr.kind };

  if (sr.sizeSol > maxTradeSol) {
    void journal.record({ stage: 'sign', outcome: 'rejected', reason: 'over_max_trade', kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, ourSizeSol: sr.sizeSol });
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
  const wb = verifyTx(tx, { owner: sr.owner, pool: sr.pool, kind: sr.kind, positionPubkey: sr.positionPubkey, inputMint: sr.sell?.inputMint ?? sr.buy?.outputMint });
  if (!wb.ok) {
    void journal.record({ stage: 'sign', outcome: 'rejected', reason: `wallb:${wb.reason}`, kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId });
    return finalize(db, sr.commandId, 'failed', { ok: false, reason: `wallb:${wb.reason}`, kind: sr.kind });
  }

  // 12-13 SIGN + LAND
  const busMs = Date.now() - sr.issuedAtMs; // latency publish(brain) → here (bus + critical section)
  if (!cfg.signingEnabled) {
    log.info({ kind: sr.kind, pool: sr.pool, our: sr.positionPubkey, sizeSol: sr.sizeSol, busMs }, '✍️  (dry-run) I would sign+land');
    return finalize(db, sr.commandId, 'skipped', { ok: true, reason: 'dry-run', kind: sr.kind });
  }
  // Retry config (fresh blockhash on each attempt), then ALERT "verify/close manually" (Valhalla-style).
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= cfg.retryMax; attempt++) {
    try {
      const tSign = Date.now();
      const fresh = Transaction.from(Buffer.from(sr.txBase64, 'base64')); // fresh tx per attempt
      // First attempt: cached blockhash (no RTT). Retries: fetch fresh in case the cached one went stale.
      const blockhash = attempt === 0 ? blockhashCache.get() : (await conn.getLatestBlockhash()).blockhash;
      fresh.feePayer = copier.publicKey;
      fresh.recentBlockhash = blockhash;
      const signers: Keypair[] = sr.kind === 'open' ? [copier, derivePositionKeypair(sr.commandId)] : [copier];
      fresh.sign(...signers);
      const sig = await land(conn, fresh.serialize());
      // A 'buy' funds a DEPENDENT two-sided open (the very next stream message): wait for it to CONFIRM so the
      // token is settled in the wallet before the open lands — else the open executes tokenless and fails.
      if (sr.kind === 'buy') await confirmLanded(conn, sig, 30_000);
      // ev:executed carries the pool/position/owner so the brain can trigger the residual sell on a close.
      await bus.publish('copybot:ev:executed', 'ev:executed', cfg.hmacKey, { commandId: sr.commandId, kind: sr.kind, sig, pool: sr.pool, positionPubkey: sr.positionPubkey, owner: sr.owner });
      void journal.record({ stage: 'sign', outcome: 'landed', kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, signature: sig, ourSizeSol: sr.sizeSol, latencyMs: Date.now() - sr.issuedAtMs, detail: recovering ? { recovering: true } : undefined });
      log.info({ kind: sr.kind, sig, attempt, busMs, signLandMs: Date.now() - tSign, totalMs: Date.now() - sr.issuedAtMs }, '🚀 signed + landed');
      return finalize(db, sr.commandId, 'landed', { ok: true, kind: sr.kind });
    } catch (e) {
      lastErr = e as Error;
      log.warn({ kind: sr.kind, attempt, error: lastErr.message }, 'sign/land failed — retry');
      if (attempt < cfg.retryMax) await sleep(cfg.retryDelayMs);
    }
  }
  // Definitive failure → emergency: especially for a CLOSE (risk of a dormant position), we alert with the link.
  await alert(log, `${sr.kind.toUpperCase()} failed after ${cfg.retryMax + 1} attempts — VERIFY/CLOSE MANUALLY`, {
    commandId: sr.commandId,
    position: sr.positionPubkey,
    link: `https://app.meteora.ag/dlmm/${sr.pool}`,
    error: lastErr?.message,
  });
  void journal.record({ stage: 'sign', outcome: 'failed', reason: 'sign_land_failed', kind: sr.kind, pool: sr.pool, ourPosition: sr.positionPubkey, commandId: sr.commandId, detail: { error: lastErr?.message } });
  return finalize(db, sr.commandId, 'failed', { ok: false, reason: 'sign_land_failed', kind: sr.kind });
}

async function finalize<T extends { ok: boolean }>(db: ReturnType<typeof openDatabase>, commandId: string, state: string, verdict: T): Promise<T> {
  await db.update(executions).set({ state, updatedAt: Date.now() }).where(eq(executions.commandId, commandId));
  return verdict;
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, 'vault fatal');
  process.exit(1);
});
