/**
 * Copy-bot · Inc.3 — VAULT process (zone Z3: the ONLY holder of the key, pull-only, NO inbound socket).
 * Consumes `cmd:sign` (XREADGROUP) and applies the ordered critical section BEFORE any signature:
 *  1-4 (bus) size/HMAC/hop · 5 Zod strict · 6 staleness (slot ≤ deadline) · 7 commandId == derive(eventKey)
 *  · 8 idempotence (INSERT executions ON CONFLICT, BEFORE) · 9 re-clamp size (local config) · 10-11 Wall B
 *  (decoding WITHOUT the SDK) · 12 SIGN · 13 LAND. In Inc.3, 12-13 = DRY-RUN (log "I would sign"), no
 *  signature. Does NOT import the DLMM SDK (firewall F3) → runs under tsx.
 *   node --import tsx --env-file=../.env src/copybot/coffre/coffre-main.ts
 */
import { randomUUID } from 'node:crypto';
import { Connection } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { createAlertWebhookSink } from '@/copybot/alert';
import { assertBusKey } from '@/copybot/bus-key-guard';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { CopyEvents } from '@/copybot/observability/copy-events';
import { EventStore } from '@/copybot/observability/event-store';
import type { CopyCode } from '@/domain/copybot/observability/codes';
import { HeartbeatStore } from '@/copybot/heartbeat-store';
import { HEARTBEAT_INTERVAL_MS } from '@/domain/copybot/status';
import { loadCopierKeypair } from '@/copybot/coffre/keypair';
import { type Ctx, process1 } from '@/copybot/coffre/process-command';
import { ConfigStore } from '@/copybot/config-store';
import { ControlChannel } from '@/infrastructure/bus/control-channel';
import { RedisBus } from '@/infrastructure/bus/redis-bus';
import { openDatabase } from '@/infrastructure/persistence/database';
import { BlockhashCache } from '@/infrastructure/solana/blockhash-cache';

const STREAM = 'copybot:cmd:sign';
const GROUP = 'coffre';
const CONSUMER = 'coffre-1';
const HOP = 'cmd:sign';
const CONFIG_POLL_MS = 5_000; // re-read the DB-backed runtime config (the maxTradeSol re-clamp ceiling) so web edits apply live

// Singleton lease: only ONE coffre may own the shared consumer/PEL. A 2nd instance booting would re-claim/re-sign
// in-flight cmd:sign from the PEL and DOUBLE-execute → it must refuse to boot while a live instance holds the lease.
const LEASE_KEY = 'copybot:coffre:lease'; // the exclusive Redis key guarding the coffre singleton
const LEASE_TTL_MS = 30_000; // a crashed holder's lease auto-expires within this window so a restart can re-acquire
const LEASE_RENEW_MS = LEASE_TTL_MS / 2; // renew well before expiry so a live holder never spuriously loses the lease

// Dead-letter routing for a REJECTED cmd:sign verdict. Pinning is code-driven (CODE_REGISTRY), so forgery/tamper/
// malformed rejects — "someone/something is wrong" — map to a PINNED code (operator paged out-of-band), while the
// expected rejects (duplicate/stale, and caps that already self-emit) map to a non-pinned internal quarantine trace.
// DLQ_POISON_CODE is the dedicated pinned `system.command_quarantined` — TRUTHFUL: the process is ALIVE and a single
// forged/malformed message was quarantined (NOT the "Bot Stopped" of system.fatal).
const DLQ_POISON_CODE: CopyCode = 'system.command_quarantined';
const DLQ_TRACE_CODE: CopyCode = 'system.loop_errored';
const POISON_REJECT_REASONS = new Set(['bad_hmac_or_hop', 'bad_schema', 'commandId_mismatch', 'owner_mismatch', 'undecodable_tx']); // forged / tampered / malformed

/** PURE: map a rejected verdict's reason to its dead-letter system code (pinned for forgery/tamper/malformed). */
export function deadLetterCode(reason: string | undefined): CopyCode {
  return reason !== undefined && POISON_REJECT_REASONS.has(reason) ? DLQ_POISON_CODE : DLQ_TRACE_CODE;
}

/** What the vault loop does with a processed message given its verdict. */
export type VerdictRoute =
  | { action: 'ack' } // terminal-OK (landed / skipped / dry-run) — clear from the group
  | { action: 'retain' } // #7 recovery in-flight (retryLater) — leave UNACKED for a later recovery pass
  | { action: 'deadLetter'; code: CopyCode }; // rejected/poison — durable quarantine + a system-event trace

/** PURE: decide the routing for a verdict; the caller performs the I/O (ack / dead-letter / leave pending). */
export function routeVerdict(verdict: { ok: boolean; reason?: string; retryLater?: boolean }): VerdictRoute {
  if (verdict.retryLater) return { action: 'retain' }; // must stay in the PEL (a prior broadcast may still land)
  if (verdict.ok) return { action: 'ack' };
  return { action: 'deadLetter', code: deadLetterCode(verdict.reason) };
}

const cfg = {
  httpUrl: process.env.SOLANA_HTTP_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6385',
  dbUrl: process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora',
  keypairPath: process.env.COPIER_KEYPAIR_PATH ?? '.wallets/copier-test.json',
  owner: process.env.COPIER_OWNER ?? 'Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz',
  maxTradeSolEnv: process.env.MAX_TRADE_SOL !== undefined ? Number(process.env.MAX_TRADE_SOL) : undefined, // env override; else the DB config's maxTradeSizeSol
  signingEnabled: process.env.SIGNING_ENABLED === 'true', // Inc.4 ; false = dry-run
  retryMax: Number(process.env.SIGN_RETRY_MAX ?? '2'), // sign+land attempts when land THROWS (no sig produced); a returned-but-unconfirmed sig is NOT retried in place (double-apply risk)
  retryDelayMs: Number(process.env.SIGN_RETRY_DELAY_MS ?? '1500'),
  confirmTimeoutMs: Number(process.env.SIGN_CONFIRM_TIMEOUT_MS ?? '45000'), // wait for on-chain confirmation before treating a landing as failed (a returned signature != execution)
  jitoBundleUrl: process.env.COPYBOT_JITO_BUNDLE_URL, // block-engine URL; absent ⇒ never bundle (plain RPC land)
  jitoEnabledEnv: process.env.COPYBOT_JITO !== undefined ? process.env.COPYBOT_JITO === 'true' : undefined, // env override of the DB jitoEnabled
};

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!cfg.httpUrl) {
    log.error('SOLANA_HTTP_URL missing');
    process.exit(1);
  }
  // Fail-closed on the bus HMAC (the vault's only transport auth): refuse to boot with a missing/insecure key.
  const busKey = assertBusKey(process.env);
  if ('error' in busKey) {
    log.error(busKey.error);
    process.exit(1);
  }
  const hmacKey = busKey.key;
  // THE-TRAP: the loaded key MUST be the expected copier wallet (fail-closed otherwise).
  const copier = loadCopierKeypair(cfg.keypairPath, cfg.owner);
  const conn = new Connection(cfg.httpUrl, 'confirmed');
  const db = openDatabase(cfg.dbUrl);
  // ONE observability emitter bound to this tenant (mono-user PoC): a tenant-scoped pino child is its logger. The
  // vault's call sites (process1 + the loop) emit TYPED codes through it directly; every row back-fills
  // user/wallet/correlation. Operator-actionable (pinned) events also fan out to the external ALERT_WEBHOOK via the
  // injected sink (no-op when unset).
  const tlog = log.child({ userId: SYSTEM_USER_ID, wallet: cfg.owner, process: 'coffre' });
  const alertSink = createAlertWebhookSink(process.env.ALERT_WEBHOOK, tlog);
  const events = new CopyEvents(new EventStore(db, tlog), tlog, { userId: SYSTEM_USER_ID, wallet: cfg.owner, process: 'coffre' }, alertSink);
  const configStore = new ConfigStore(db, log);
  let runtimeConfig = await configStore.seedIfAbsent(); // DB-backed config; the maxTradeSol re-clamp ceiling is read live (env wins when set)
  const maxTradeSol = (): number => cfg.maxTradeSolEnv ?? runtimeConfig.user.sizing.maxTradeSizeSol;
  // Jito bundle landing is active only when jitoEnabled (env override else DB config) AND a block-engine URL is set.
  const jitoBundleUrl = (): string | undefined => ((cfg.jitoEnabledEnv ?? runtimeConfig.user.jitoEnabled) ? cfg.jitoBundleUrl : undefined); // user ceiling (per-leader can only lower it)
  const reloadConfig = async (): Promise<void> => {
    runtimeConfig = await configStore.load();
  };
  const control = ControlChannel.connect(cfg.redisUrl); // instant config-reload pings (re-clamp ceiling in <100ms)
  const heartbeat = new HeartbeatStore(db, log, 'coffre'); // process status the web reads (vault online + signing state)
  const bus = RedisBus.connect(cfg.redisUrl);
  await bus.ensureGroup(STREAM, GROUP);
  // SINGLETON GUARD (before ANY processing/recovery): acquire the exclusive coffre lease. A 2nd instance booting with
  // the same consumer would re-claim/re-sign this consumer's in-flight PEL and DOUBLE-execute — so if the lease is
  // already held by a live instance, refuse to boot. The lease auto-expires (TTL) if the holder crashes.
  const instanceId = `${CONSUMER}:${process.pid}:${randomUUID()}`;
  if (!(await bus.acquireLease(LEASE_KEY, instanceId, LEASE_TTL_MS))) {
    log.error({ key: LEASE_KEY, instanceId }, '🔒 another vault instance holds the singleton lease — refusing to boot (would double-sign in-flight commands)');
    process.exit(1);
  }
  // Renew on a ttl/2 timer so a live holder never loses the lease. If a renew ever fails (our lease expired and was
  // taken by another instance, e.g. after a long Redis outage), we lost exclusivity → exit to avoid a split-brain
  // double-sign. A transient renew error is logged and retried on the next tick (ioredis retries the connection).
  const leaseTimer = setInterval(() => {
    void bus
      .renewLease(LEASE_KEY, instanceId, LEASE_TTL_MS)
      .then((ok) => {
        if (!ok) {
          log.error({ key: LEASE_KEY, instanceId }, '🔒 lost the singleton lease (expired/taken) — exiting to avoid a split-brain double-sign');
          process.exit(1);
        }
      })
      .catch((e) => log.error({ err: (e as Error).message }, 'lease renew failed (will retry next tick)'));
  }, LEASE_RENEW_MS);
  const blockhashCache = new BlockhashCache(async () => {
    const b = await conn.getLatestBlockhash();
    return { blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight };
  });
  await blockhashCache.start(); // first sign attempt reads it instantly (no getLatestBlockhash RTT)
  log.info({ owner: copier.publicKey.toBase58(), signing: cfg.signingEnabled }, '🔐 vault started (pull-only)');

  // CRASH RECOVERY (no-miss): re-process any cmd:sign a prior (crashed) instance read but never ACKed — its PEL,
  // re-read with XREADGROUP id '0'. Exactly-once is guaranteed by the executions table (a landed command is a
  // duplicate; a stranded 'claimed' one is re-claimable). Without this, a vault crash mid-sign would STRAND an
  // in-flight open/close forever (XREADGROUP '>' never re-delivers it) → a missed copy.
  const ctxBase = { conn, db, bus, copier, blockhashCache, events, signingEnabled: cfg.signingEnabled, hmacKey, retryMax: cfg.retryMax, retryDelayMs: cfg.retryDelayMs, confirmTimeoutMs: cfg.confirmTimeoutMs, log };
  // Process a batch, ACKing each message ONLY after process1 returned a verdict. If process1 THROWS (transient I/O
  // such as a getSlot RPC blip, BEFORE the idempotency claim), the message is left UNACKED in the PEL — the next
  // pending-drain retries it (a throwing message must never be silently dropped nor strand the rest of the batch).
  const processBatch = async (msgs: Awaited<ReturnType<typeof bus.consume>>, recovering = false): Promise<void> => {
    for (const msg of msgs) {
      try {
        const ctx: Ctx = { ...ctxBase, maxTradeSol: maxTradeSol(), jitoBundleUrl: jitoBundleUrl() };
        const verdict = await process1(msg.payload, ctx, recovering);
        log.info({ id: msg.id, recovering, ...verdict }, verdict.ok ? '✅ processed' : '⛔ rejected');
        // Route by verdict (pure decision, I/O here):
        //  - retain (#7 recovery in-flight): leave UNACKED so a later pass re-checks the chain — ACKing would strand it;
        //  - deadLetter (rejected/poison): move the raw message to the DLQ + emit a system-event trace (PINNED for a
        //    forged/malformed command — "something is wrong"; internal for the expected duplicate/stale), instead of a
        //    SILENT ack that would let a poison/forged message vanish without a durable trace;
        //  - ack (terminal-OK): clear it as before (idempotence guarded by the executions table).
        const route = routeVerdict(verdict);
        if (route.action === 'retain') continue;
        if (route.action === 'deadLetter') {
          events.system(route.code, undefined, {
            stage: 'sign',
            outcome: 'rejected',
            reason: `dead_letter:${verdict.reason ?? 'unknown'}`,
            adminDetail: { id: msg.id, reason: verdict.reason, kind: verdict.kind, recovering },
          });
          await bus.deadLetter(STREAM, GROUP, msg.id, msg.raw);
        } else {
          await bus.ack(STREAM, GROUP, msg.id);
        }
      } catch (e) {
        // process1 threw (transient I/O before the idempotency claim) → the message is left UNACKED for retry. An
        // internal loop self-failure (NEVER user-notified — loop guard, SPEC §6); the row carries the cause.
        events.system('system.loop_errored', e, { stage: 'sign', outcome: 'failed', reason: 'loop_errored', adminDetail: { id: msg.id, phase: 'process1' } });
      }
    }
  };
  try {
    // Crash recovery (recovering=true → a stranded 'claimed' from a CRASHED prior instance is re-claimable).
    await processBatch(await bus.consumePending(STREAM, GROUP, CONSUMER, HOP, hmacKey, 100), true);
  } catch (e) {
    events.system('system.recovery_failed', e, { stage: 'recover', outcome: 'failed', reason: 'recovery_failed', adminDetail: { phase: 'boot_pending_recovery' } });
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
    clearInterval(leaseTimer);
    blockhashCache.stop();
    await bus.releaseLease(LEASE_KEY, instanceId).catch(() => {}); // best-effort; the TTL reclaims it anyway
    await Promise.all([bus.quit(), control.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  let backoff = 1000;
  do {
    try {
      // Re-drain the PEL FIRST: any message a prior iteration left pending is retried here without waiting for a
      // restart (consumePending at boot alone would strand it until then). recovering=true — a pending message is
      // ALWAYS a prior read that never finalized (a process1 throw, OR a #7 in-flight left unACKed), so it must get
      // the exactly-once recovery pre-check (a landed tx is finalized, a still-in-flight one is left, only a dead
      // one is re-signed). Harmless for a pre-claim throw (no 'submitted' row ⇒ the pre-check is a no-op).
      await processBatch(await bus.consumePending(STREAM, GROUP, CONSUMER, HOP, hmacKey, 100), true);
      await processBatch(await bus.consume(STREAM, GROUP, CONSUMER, HOP, hmacKey, 10, drain ? 3000 : 5000));
      backoff = 1000; // success → reset
    } catch (e) {
      // never crash: record + exponential backoff + continue (Redis/RPC may recover). Internal loop self-failure.
      events.system('system.loop_errored', e, { stage: 'sign', outcome: 'failed', reason: 'loop_errored', adminDetail: { loop: 'vault_consume', backoff } });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
    if (drain) break;
  } while (!stopped);
  if (drain) await stop();
}

// Auto-run as the process entrypoint. Guarded so importing this module in a unit test (vitest sets process.env.VITEST;
// production never does) does NOT boot the vault — the pure helpers above (routeVerdict/deadLetterCode) stay testable
// without triggering env reads / Redis connections / process.exit.
if (!process.env.VITEST) {
  main().catch((e) => {
    log.error({ err: (e as Error).message }, 'vault fatal');
    process.exit(1);
  });
}
