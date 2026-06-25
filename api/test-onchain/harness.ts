/**
 * Copy-bot · on-chain test harness (the engine). Drives the LEADER-TEST wallet (bundled leader-control CLI),
 * waits for the BOT (spawned by global-setup) to copy on-chain, and compares real fidelity. The @meteora-ag/dlmm
 * SDK only loads BUNDLED, never under vitest/ESM — so every SDK-touching read goes through the bundled
 * `bench-reader` CLI (JSON out); only SDK-free work (token balances, JSON parsing) runs in-process. Type-only
 * imports of SDK modules are erased by esbuild, so they're safe.
 *
 * `resetState` is the central guardrail: after every test (pass OR fail) it closes the leader position, waits for
 * the copy to close, sweeps both wallets to SOL, and asserts a clean slate. These are REAL tests — every
 * assertion checks on-chain truth produced by the actual bot; nothing is stubbed.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { type Connection, PublicKey } from '@solana/web3.js';
import type { UserPosition } from '@/infrastructure/solana/dlmm/leader-position-reader';
import type { FidelityResult } from '@/infrastructure/solana/dlmm/shape-fidelity';
import { readAllOwnerTokenBalances } from '@/infrastructure/solana/token-balance-reader';
import { COPIER_TEST, LEADER_TEST } from './env';

const execFileAsync = promisify(execFile);
const LEADER_CLI = 'dist/copybot/scripts/leader-control.cjs';
const BENCH_CLI = 'dist/copybot/scripts/bench-reader.cjs';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function run(cli: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('node', [cli, ...args], { env: process.env, maxBuffer: 1 << 22 });
    return stdout;
  } catch (e) {
    // Surface the CLI's own stdout/stderr (e.g. a Jupiter 429, an on-chain error) — not just "Command failed".
    const err = e as { message: string; stdout?: string; stderr?: string };
    throw new Error(`${err.message}\n  stdout: ${(err.stdout ?? '').trim().slice(-500)}\n  stderr: ${(err.stderr ?? '').trim().slice(-500)}`);
  }
}
const positionFromOut = (out: string): string => {
  const m = out.match(/position=([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (!m?.[1]) throw new Error(`no position in leader-control output:\n${out}`);
  return m[1];
};

export interface OpenOpts {
  pool: string;
  strategy?: 'spot' | 'bidask' | 'curve';
  dist?: string;
  sol?: number;
  twosided?: boolean;
  token?: number;
}

export class Harness {
  constructor(private readonly conn: Connection) {}

  // ── leader actions (bundled leader-control CLI) ──────────────────────────────────────────────────────────
  async leaderOpen(o: OpenOpts): Promise<string> {
    const args = ['open', `--pool=${o.pool}`, `--sol=${o.sol ?? 0.1}`];
    if (o.twosided) args.push('--twosided', `--token=${o.token ?? 4_000_000}`);
    if (o.dist) args.push(`--dist=${o.dist}`);
    else args.push(`--strategy=${o.strategy ?? 'spot'}`);
    return positionFromOut(await run(LEADER_CLI, args));
  }
  async leaderAdd(o: OpenOpts): Promise<void> {
    const args = ['add', `--pool=${o.pool}`, `--sol=${o.sol ?? 0.04}`];
    if (o.twosided) args.push('--twosided', `--token=${o.token ?? 2_000_000}`);
    else if (o.dist) args.push(`--dist=${o.dist}`);
    await run(LEADER_CLI, args);
  }
  async leaderRemove(pool: string, bps: number, fromBin?: number, toBin?: number): Promise<void> {
    const args = ['remove', `--pool=${pool}`, `--bps=${bps}`];
    if (fromBin !== undefined) args.push(`--frombin=${fromBin}`);
    if (toBin !== undefined) args.push(`--tobin=${toBin}`);
    await run(LEADER_CLI, args);
  }
  async leaderClaim(pool: string): Promise<void> {
    await run(LEADER_CLI, ['claim', `--pool=${pool}`]);
  }
  async leaderClose(pool: string): Promise<void> {
    await run(LEADER_CLI, ['close', `--pool=${pool}`]).catch(() => undefined); // idempotent (tolerates "no position")
  }
  /** Close EVERY leader position on the pool, INCLUDING emptied-but-open ones (which `close` and readUserPositions
   *  skip). Used by recovery + the empty-then-close edge tests. */
  async leaderCloseAll(pool: string): Promise<void> {
    await run(LEADER_CLI, ['close-all', `--pool=${pool}`]).catch(() => undefined);
  }

  // ── SDK reads (bundled bench-reader CLI → JSON) ──────────────────────────────────────────────────────────
  private async benchPositions(owner: PublicKey): Promise<UserPosition[]> {
    return JSON.parse(await run(BENCH_CLI, ['positions', owner.toBase58()])) as UserPosition[];
  }
  async copierPositions(pool: string): Promise<UserPosition[]> {
    return (await this.benchPositions(COPIER_TEST)).filter((p) => p.pool === pool);
  }
  async leaderPositions(pool: string): Promise<UserPosition[]> {
    return (await this.benchPositions(LEADER_TEST)).filter((p) => p.pool === pool);
  }
  /** DIAGNOSTIC: dump both positions' per-bin SOL legs (offset-from-active) to stderr — for understanding a
   *  selective reshape divergence. Not an assertion. */
  async logShapes(pool: string, leaderPos: string, copyPos: string): Promise<void> {
    const lead = await run(BENCH_CLI, ['shape', pool, LEADER_TEST.toBase58(), leaderPos]);
    const copy = await run(BENCH_CLI, ['shape', pool, COPIER_TEST.toBase58(), copyPos]);
    console.error(`[shape leader] ${lead.trim()}`);
    console.error(`[shape copy  ] ${copy.trim()}`);
  }
  /** Read a position's shape: per-bin SOL/token (raw) keyed by offset-from-active + the bin range. */
  async shape(owner: PublicKey, pos: string, pool: string): Promise<{ activeBinId: number; lowerBinId: number; upperBinId: number; bins: Array<{ off: number; sol: number; tok: number }> }> {
    return JSON.parse(await run(BENCH_CLI, ['shape', pool, owner.toBase58(), pos]));
  }
  leaderShape(pos: string, pool: string): ReturnType<Harness['shape']> {
    return this.shape(LEADER_TEST, pos, pool);
  }
  /** Bot REACTION latency (ms): from when the brain SAW the leader event ("👁️ event routed") to when the coffre
   *  LANDED our copy ("🚀 signed + landed"), correlated by kind. This is the controllable end-to-end SLA — the RPC
   *  WS-propagation BEFORE "event routed" is infra latency, not the bot. Returns null if a marker is missing. */
  copyLatencyMs(kind: 'open' | 'close'): number | null {
    const stamp = (path: string, msg: string): number | null => {
      let log: string;
      try {
        log = readFileSync(path, 'utf8');
      } catch {
        return null;
      }
      const line = log.split('\n').filter((l) => l.includes(msg) && l.includes(`"kind":"${kind}"`)).at(-1);
      const m = line?.match(/"time":(\d+)/);
      return m ? Number(m[1]) : null;
    };
    const routed = stamp('/tmp/bench-brain.log', '👁️ event routed');
    const landed = stamp('/tmp/bench-coffre.log', '🚀 signed + landed');
    return routed != null && landed != null ? landed - routed : null;
  }
  /** Compare on-chain fidelity. Retries on a transient "missing" (the SDK position enumerator can lag a freshly
   *  landed copy by a few seconds — the account exists [waitForCopy confirmed it], it's just not indexed yet). */
  async fidelity(pool: string, leaderPos: string, copyPos: string): Promise<FidelityResult> {
    for (let attempt = 0; ; attempt++) {
      const out = await run(BENCH_CLI, ['fidelity', pool, LEADER_TEST.toBase58(), leaderPos, COPIER_TEST.toBase58(), copyPos]);
      const r = JSON.parse(out) as FidelityResult & { missing?: boolean };
      if (!r.missing) {
        console.error(`[fidelity] totalRatio=${r.totalRatio?.toFixed(3)} solLegRatio=${r.solLegRatio?.toFixed(3)} tokenLegRatio=${r.tokenLegRatio?.toFixed(3)} maxEconDiff=${r.maxEconDiffPct?.toFixed(2)}% leaderSol=${r.totalLeaderSol?.toFixed(5)} copySol=${r.totalCopySol?.toFixed(5)}`);
        return r;
      }
      if (attempt >= 4) throw new Error(`fidelity: a position is still missing on-chain after retries (${out})`);
      await sleep(3000);
    }
  }
  async copierTokens(): Promise<Array<{ mint: string; amountRaw: bigint }>> {
    return readAllOwnerTokenBalances(this.conn, COPIER_TEST); // SDK-free (web3 only) → safe in-process
  }

  // ── robust copy detection (direct getAccountInfo via the brain-published copy pubkey — the SDK position
  //    enumerator LAGS both fresh opens and closes, so we read the exact account instead). ──────────────────
  /** The copy position pubkey of the most recent open the brain published (from its tee'd log). */
  private lastPublishedCopy(): string | null {
    let log: string;
    try {
      log = readFileSync('/tmp/bench-brain.log', 'utf8');
    } catch {
      return null;
    }
    const m = [...log.matchAll(/"kind":"open"[^\n]*?"our":"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)];
    return m.length ? (m[m.length - 1]?.[1] ?? null) : null;
  }
  /** Does the brain's tee'd log currently contain `substr`? (Used to corroborate a decision, e.g. an open BLOCKED
   *  by the kill-switch vs a missed event.) */
  brainLogIncludes(substr: string): boolean {
    try {
      return readFileSync('/tmp/bench-brain.log', 'utf8').includes(substr);
    } catch {
      return false;
    }
  }
  /** Does a position/account exist on-chain (direct read — no enumerator lag)? */
  async accountExists(pubkey: string): Promise<boolean> {
    return (await this.conn.getAccountInfo(new PublicKey(pubkey))) !== null;
  }

  /** Wait until the bot has published AND landed the copy open (the new copy account exists on-chain). */
  async waitForCopy(_pool: string, timeoutMs = 35_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pk = this.lastPublishedCopy();
      if (pk && (await this.accountExists(pk))) return pk;
      await sleep(1500);
    }
    throw new Error(`timeout: bot did not copy/land an open within ${timeoutMs}ms`);
  }
  /** Wait until the copy position account is gone (closed). Direct read — no enumerator lag. */
  async waitForCopyClosed(copyPubkey: string, timeoutMs = 45_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.accountExists(copyPubkey))) return;
      await sleep(1500);
    }
    throw new Error(`timeout: bot did not close copy ${copyPubkey} within ${timeoutMs}ms`);
  }
  /** Give the bot time to react to a leader add/remove (reshape), then settle on-chain. */
  reshapeSettle = (): Promise<void> => sleep(8000);

  /**
   * Poll fidelity until the copy's ABSOLUTE economic size (SOL) satisfies `done` AND has SETTLED — the robust "the
   * reshape fully landed on the copy" signal. A ratio alone can read ≈0.5 from stale/un-indexed state, and a single
   * threshold-crossing can catch the copy MID-reshape (a multi-step trim/add still in flight) → a misleading shape
   * diff. So we require two consecutive reads within `SETTLE_PCT` of each other: the size stopped moving. A reshape
   * that never lands (regression) leaves the size flat → `done` never true → this THROWS → the test FAILS.
   */
  async waitForCopyResize(
    pool: string,
    leaderPos: string,
    copyPos: string,
    done: (copySol: number) => boolean,
    timeoutMs = 90_000,
  ): Promise<FidelityResult> {
    const SETTLE_PCT = 0.04; // ≤4% change between consecutive reads ⇒ the reshape has settled (not mid-flight)
    const deadline = Date.now() + timeoutMs;
    let last: FidelityResult | null = null;
    let prevCopySol = Number.NaN;
    while (Date.now() < deadline) {
      last = await this.fidelity(pool, leaderPos, copyPos);
      const cur = last.totalCopySol;
      const settled = Number.isFinite(prevCopySol) && Math.abs(cur - prevCopySol) / Math.max(cur, 1e-9) <= SETTLE_PCT;
      if (done(cur) && settled) return last;
      prevCopySol = cur;
      await sleep(4000);
    }
    throw new Error(`timeout: copy did not resize+settle as expected within ${timeoutMs}ms (last copySol=${last?.totalCopySol})`);
  }

  /**
   * RESET (afterEach guardrail, idempotent, runs even after a failure). Closes ALL leader positions → waits for the
   * bot to close its copy (direct account read) → sweeps leader-test token→SOL. The COPIER wallet's token is swept
   * ASYNCHRONOUSLY by the bot (its no-miss sweep) — not blocked on here; a dedicated sweep test asserts it.
   *
   * Uses `close-all` (NOT `close`): a `close` only handles the first LIQUIDITY-bearing position, so an emptied-but-
   * open leader (the remove-to-zero edge) would survive → the reconcile sees "leader still on-chain" → KEEPS the copy
   * → a dormant copied position accumulates and drains the copier. close-all closes empties too → the reconcile then
   * closes the orphaned copy. This is what keeps the bench from leaving ANY dormant position between tests.
   */
  async resetState(pool: string): Promise<void> {
    const copy = this.lastPublishedCopy();
    await this.leaderCloseAll(pool);
    if (copy) await this.waitForCopyClosed(copy).catch(() => undefined); // best-effort; the close test asserts strictly
    await run(LEADER_CLI, ['sweep']).catch(() => undefined); // leader-test token→SOL
  }
}
