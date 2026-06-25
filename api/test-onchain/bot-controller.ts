/**
 * Copy-bot · on-chain bench — BOT lifecycle controller. Spawns coffre + brain IN THE TEST WORKER (singleFork →
 * this module-singleton persists across all test files), so chaos tests can kill/restart the brain mid-run.
 * global-setup only builds + checks funding; here we start/kill/restart. Cleanup on worker exit. Bot stdout is
 * tee'd to /tmp/bench-{coffre,brain}.log (the harness reads the brain log for the published copy pubkey).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { LEADER_TEST } from './env';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let coffre: ChildProcess | undefined;
let brain: ChildProcess | undefined;

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

// DUST_TOKEN_RAW=1e6 (≈1 USDC, 6-dec): a fresh "spot" open picks up a sub-1-USDC token leg from active-bin arb —
// NOT worth a two-sided buy (wasteful + the tiny two-sided open is flaky). Above this → genuine two-sided.
const brainEnv = (): NodeJS.ProcessEnv => ({ ...process.env, SIGNING_ENABLED: 'true', COPYBOT_LEADER: LEADER_TEST.toBase58(), COPYBOT_TWO_SIDED: 'on', COPYBOT_MIN_POSITION_SOL: '0.02', DUST_TOKEN_RAW: '1000000' });

export async function startCoffre(): Promise<void> {
  if (coffre && coffre.exitCode === null) return;
  coffre = await spawnUntil('coffre', ['--import', 'tsx', 'src/copybot/coffre/coffre-main.ts'], { ...process.env, SIGNING_ENABLED: 'true' }, '🔐 vault started', 30_000);
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
export async function startBrain(extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  if (brain && brain.exitCode === null) return;
  brain = await spawnUntil('brain', ['dist/copybot/src/copybot/brain/brain-main.cjs'], { ...brainEnv(), ...extraEnv }, 'replay done', 40_000);
}
/** Restart the brain with EXTRA env (e.g. COPYBOT_KILL_SWITCH=true) to exercise a runtime config. The caller is
 *  responsible for restoring the default brain (restartBrain) afterwards — the test's afterEach does this. */
export async function restartBrainWithEnv(extraEnv: NodeJS.ProcessEnv): Promise<void> {
  await killBrain();
  await startBrain(extraEnv);
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
/** Restart the brain (it re-runs replay + reconcile on boot). */
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
