/**
 * Copy-bot · Inc.3 — VAULT process (zone Z3: the ONLY holder of the key, pull-only, NO inbound socket).
 * Consumes `cmd:sign` (XREADGROUP) and applies the ordered critical section BEFORE any signature:
 *  1-4 (bus) size/HMAC/hop · 5 Zod strict · 6 staleness (slot ≤ deadline) · 7 commandId == derive(eventKey)
 *  · 8 idempotence (INSERT executions ON CONFLICT, BEFORE) · 9 re-clamp size (local config) · 10-11 Wall B
 *  (decoding WITHOUT the SDK) · 12 SIGN · 13 LAND. In Inc.3, 12-13 = DRY-RUN (log "I would sign"), no
 *  signature. Does NOT import the DLMM SDK (firewall F3) → runs under tsx.
 *   node --import tsx --env-file=../.env src/copybot/coffre/coffre-main.ts
 */
import { Connection } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { bindAlertEvents } from '@/copybot/alert';
import { SYSTEM_USER_ID } from '@/copybot/journal-store';
import { CopyEvents } from '@/copybot/observability/copy-events';
import { EventStore } from '@/copybot/observability/event-store';
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

const cfg = {
  httpUrl: process.env.SOLANA_HTTP_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6385',
  dbUrl: process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora',
  hmacKey: process.env.BUS_HMAC_KEY ?? 'dev-k-sign-CHANGE-ME',
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
  // THE-TRAP: the loaded key MUST be the expected copier wallet (fail-closed otherwise).
  const copier = loadCopierKeypair(cfg.keypairPath, cfg.owner);
  const conn = new Connection(cfg.httpUrl, 'confirmed');
  const db = openDatabase(cfg.dbUrl);
  // ONE observability emitter bound to this tenant (mono-user PoC): a tenant-scoped pino child is its logger. The
  // vault's call sites (process1 + the loop) now emit TYPED codes through it directly (P2); `bindAlertEvents` keeps
  // the un-migrated `alert()` shim durable + feed-visible. Every row back-fills user/wallet/correlation.
  const tlog = log.child({ userId: SYSTEM_USER_ID, wallet: cfg.owner, process: 'coffre' });
  const events = new CopyEvents(new EventStore(db, tlog), tlog, { userId: SYSTEM_USER_ID, wallet: cfg.owner, process: 'coffre' });
  bindAlertEvents(events); // the alert() shim (P1) still persists a pinned, feed-visible row for any non-migrated caller
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
  const blockhashCache = new BlockhashCache(async () => (await conn.getLatestBlockhash()).blockhash);
  await blockhashCache.start(); // first sign attempt reads it instantly (no getLatestBlockhash RTT)
  log.info({ owner: copier.publicKey.toBase58(), signing: cfg.signingEnabled }, '🔐 vault started (pull-only)');

  // CRASH RECOVERY (no-miss): re-process any cmd:sign a prior (crashed) instance read but never ACKed — its PEL,
  // re-read with XREADGROUP id '0'. Exactly-once is guaranteed by the executions table (a landed command is a
  // duplicate; a stranded 'claimed' one is re-claimable). Without this, a vault crash mid-sign would STRAND an
  // in-flight open/close forever (XREADGROUP '>' never re-delivers it) → a missed copy.
  const ctxBase = { conn, db, bus, copier, blockhashCache, events, signingEnabled: cfg.signingEnabled, hmacKey: cfg.hmacKey, retryMax: cfg.retryMax, retryDelayMs: cfg.retryDelayMs, confirmTimeoutMs: cfg.confirmTimeoutMs, log };
  // Process a batch, ACKing each message ONLY after process1 returned a verdict. If process1 THROWS (transient I/O
  // such as a getSlot RPC blip, BEFORE the idempotency claim), the message is left UNACKED in the PEL — the next
  // pending-drain retries it (a throwing message must never be silently dropped nor strand the rest of the batch).
  const processBatch = async (msgs: Awaited<ReturnType<typeof bus.consume>>, recovering = false): Promise<void> => {
    for (const msg of msgs) {
      try {
        const ctx: Ctx = { ...ctxBase, maxTradeSol: maxTradeSol(), jitoBundleUrl: jitoBundleUrl() };
        const verdict = await process1(msg.payload, ctx, recovering);
        log.info({ id: msg.id, recovering, ...verdict }, verdict.ok ? '✅ processed' : '⛔ rejected');
        await bus.ack(STREAM, GROUP, msg.id); // idempotence guaranteed by the executions table
      } catch (e) {
        // process1 threw (transient I/O before the idempotency claim) → the message is left UNACKED for retry. An
        // internal loop self-failure (NEVER user-notified — loop guard, SPEC §6); the row carries the cause.
        events.system('system.loop_errored', e, { stage: 'sign', outcome: 'failed', reason: 'loop_errored', adminDetail: { id: msg.id, phase: 'process1' } });
      }
    }
  };
  try {
    // Crash recovery (recovering=true → a stranded 'claimed' from a CRASHED prior instance is re-claimable).
    await processBatch(await bus.consumePending(STREAM, GROUP, CONSUMER, HOP, cfg.hmacKey, 100), true);
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
    blockhashCache.stop();
    await Promise.all([bus.quit(), control.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  let backoff = 1000;
  do {
    try {
      // Re-drain the PEL FIRST: any message a prior iteration left pending (a process1 throw) is retried here
      // without waiting for a restart (consumePending at boot alone would strand it until then).
      await processBatch(await bus.consumePending(STREAM, GROUP, CONSUMER, HOP, cfg.hmacKey, 100));
      await processBatch(await bus.consume(STREAM, GROUP, CONSUMER, HOP, cfg.hmacKey, 10, drain ? 3000 : 5000));
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

main().catch((e) => {
  log.error({ err: (e as Error).message }, 'vault fatal');
  process.exit(1);
});
