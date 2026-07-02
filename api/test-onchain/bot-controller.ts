/**
 * Copy-bot · on-chain bench — BOT lifecycle controller. Spawns coffre + brain IN THE TEST WORKER (singleFork →
 * this module-singleton persists across all test files), so chaos tests can kill/restart the brain mid-run.
 * global-setup only builds + checks funding; here we start/kill/restart. Cleanup on worker exit. Bot stdout is
 * tee'd to /tmp/bench-{coffre,brain}.log (the harness reads the brain log for the published copy pubkey).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pino } from 'pino';
import type { CapsConfig } from '@/domain/copybot/caps';
import { openDatabase } from '@/infrastructure/persistence/database';
import { seedBenchConfig } from './bench-config';
import { LEADER_TEST } from './env';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let coffre: ChildProcess | undefined;
let brain: ChildProcess | undefined;

// The bench seeds the bot's runtime config directly into the DB (see bench-config.ts) — same DB the brain reads
// (Postgres :5435). Lazy so merely importing this module (base vitest collects the onchain files) opens no pool.
const DB_URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const benchLog = pino({ level: 'warn' }); // quiet — config-store info logs would spam the bench output
let benchDb: ReturnType<typeof openDatabase> | undefined;
const db = (): ReturnType<typeof openDatabase> => (benchDb ??= openDatabase(DB_URL));

function spawnUntil(label: string, args: string[], env: NodeJS.ProcessEnv, ready: string, timeoutMs: number): Promise<ChildProcess> {
  const logFile = createWriteStream(`/tmp/bench-${label}.log`, { flags: 'w' });
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { env });
    const timer = setTimeout(() => reject(new Error(`${label} not ready (${ready}) in ${timeoutMs}ms — see /tmp/bench-${label}.log`)), timeoutMs);
    const onData = (buf: Buffer): void => {
      logFile.write(buf);
      if (buf.toString().includes(ready)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${label} exited early (code ${code}) — see /tmp/bench-${label}.log`)));
  });
}

// Bootstrap env ONLY (infra/secrets — NOT tunables; sizing/caps/two-sided/dust/infiniteAdd now live in the DB config
// seeded by seedBenchConfig). COPYBOT_LEADER = the leader to follow (brain reads it directly for `cfg.leader`).
// COPYBOT_DEV_BUS_KEY=true: the boot bus-key guard is fail-closed (rejects a missing/default BUS_HMAC_KEY); the bench
// runs locally without a real key, so it opts into the public dev default explicitly. A real BUS_HMAC_KEY in the env
// still takes precedence — this only unblocks the no-key local case.
const brainEnv = (): NodeJS.ProcessEnv => ({ ...process.env, SIGNING_ENABLED: 'true', COPYBOT_DEV_BUS_KEY: 'true', COPYBOT_LEADER: LEADER_TEST.toBase58() });

export async function startCoffre(): Promise<void> {
  if (coffre && coffre.exitCode === null) return;
  coffre = await spawnUntil('coffre', ['--import', 'tsx', 'src/copybot/coffre/coffre-main.ts'], { ...process.env, SIGNING_ENABLED: 'true', COPYBOT_DEV_BUS_KEY: 'true' }, '🔐 vault started', 30_000);
}
/** Kill ONLY the coffre (the brain keeps running + publishing). Simulates a vault crash. */
export async function killCoffre(): Promise<void> {
  coffre?.kill('SIGKILL');
  coffre = undefined;
  await sleep(800);
}
/** Restart the coffre (re-runs the boot PENDING-recovery, then resumes consuming). */
export async function restartCoffre(): Promise<void> {
  await killCoffre();
  await startCoffre();
}
export async function startBrain(capsPatch: Partial<CapsConfig> = {}): Promise<void> {
  if (brain && brain.exitCode === null) return;
  await seedBenchConfig(db(), benchLog, capsPatch); // seed the DB config BEFORE boot so seedIfAbsent/load pick it up
  brain = await spawnUntil('brain', ['dist/copybot/src/copybot/brain/brain-main.cjs'], brainEnv(), 'replay done', 40_000);
}
/** Restart the brain after patching the account-wide caps in the DB config (e.g. { killSwitchGlobal: true } or
 *  { maxOpenPositions: 1 }) to exercise a runtime config. The caller is responsible for restoring the default brain
 *  (restartBrain re-seeds the base bench config) afterwards — the test's afterEach does this. */
export async function restartBrainWithConfig(capsPatch: Partial<CapsConfig>): Promise<void> {
  await killBrain();
  await startBrain(capsPatch);
}
/** Idempotent: start both if not already running. */
export async function ensureBotStarted(): Promise<void> {
  await startCoffre();
  await startBrain();
}
/** Kill the brain (simulates a crash / disconnect). The coffre keeps running. */
export async function killBrain(): Promise<void> {
  brain?.kill('SIGKILL');
  brain = undefined;
  await sleep(800);
}
/** Restart the brain (re-seeds the BASE bench config — clearing any prior caps patch — then re-runs replay + reconcile on boot). */
export async function restartBrain(): Promise<void> {
  await killBrain();
  await startBrain();
}
export function stopBot(): void {
  brain?.kill('SIGKILL');
  coffre?.kill('SIGKILL');
  brain = undefined;
  coffre = undefined;
}

process.on('exit', stopBot);
