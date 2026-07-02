/**
 * Copy-bot · Inc.2 — detection I/O adapters (listSignaturesSince + classify), WITHOUT the Meteora SDK.
 * Provides the `DetectorDeps` for the `LeaderDetector` (pure no-miss core). The tx building (SDK) is elsewhere
 * (brain). Pagination/no-miss-guardrail logic taken from the P1 CLI (proven).
 */
import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type { Connection, PublicKey } from '@solana/web3.js';
import { type PoolMetaLookup, buildDetectedEvent, poolsOf } from '../domain/copybot/classify-dlmm-tx';
import type { DetectedEvent } from '../domain/copybot/events';
import type { ClassifyResult, DetectorDeps, SigInfo } from '../domain/copybot/leader-detector';
import type { LoadedPoolMeta } from '../domain/dlmm';
import type { OnchainPoolMetaReader } from '../infrastructure/solana/dlmm/pool-meta';
import type { HeliusTokenMetadataGateway } from '../infrastructure/solana/token-metadata-gateway';

const REPLAY_LIMIT = 25;
const SIG_PAGE = 1000;
const MAX_POLL_PAGES = 25;
const TX_FETCH_RETRIES = 3; // a WS notification can outrun tx availability at the RPC read replica
const TX_FETCH_RETRY_MS = 350; // short backoff between null-tx refetches (fast-close path)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function makeDetectionDeps(args: {
  conn: Connection;
  pk: PublicKey;
  poolReader: OnchainPoolMetaReader;
  tokenMeta: HeliusTokenMetadataGateway;
  onEvent: DetectorDeps['onEvent'];
  persist?: DetectorDeps['persist'];
  onGap?: DetectorDeps['onGap'];
}): DetectorDeps {
  const { conn, pk, poolReader, tokenMeta, onEvent, persist, onGap } = args;
  const poolMetaCache = new Map<string, LoadedPoolMeta | null>();
  const getPoolMeta = async (lbPair: string): Promise<LoadedPoolMeta | null> => {
    const cached = poolMetaCache.get(lbPair);
    if (cached !== undefined) return cached;
    const meta = await poolReader.loadPoolMeta(lbPair);
    poolMetaCache.set(lbPair, meta);
    return meta;
  };

  return {
    async listSignaturesSince(until: string | undefined): Promise<SigInfo[]> {
      // Cold start: bounded recent history (we don't replay the whole wallet).
      if (until === undefined) {
        const page = await conn.getSignaturesForAddress(pk, { limit: REPLAY_LIMIT });
        return page.filter((s) => s.err === null).map((s) => ({ signature: s.signature }));
      }
      // Poll: COMPLETE pagination of everything newer than `until` (contiguous sweep, no-miss).
      const out: SigInfo[] = [];
      let before: string | undefined;
      for (let p = 1; ; p++) {
        const batch = await conn.getSignaturesForAddress(pk, { until, before, limit: SIG_PAGE });
        if (batch.length === 0) break;
        for (const s of batch) if (s.err === null) out.push({ signature: s.signature });
        before = batch[batch.length - 1]?.signature;
        if (batch.length < SIG_PAGE) break;
        if (p >= MAX_POLL_PAGES) {
          throw new Error(`poll: ${MAX_POLL_PAGES} full pages without reaching the cursor — retry on the next poll.`);
        }
      }
      return out;
    },

    async classify(signatures: string[]): Promise<ClassifyResult> {
      const opts = { maxSupportedTransactionVersion: 0 as const, commitment: 'confirmed' as const };
      let txs = await conn.getParsedTransactions(signatures, opts);
      // Refetch ONLY the still-null slots (WS outran RPC availability). Keeps the poll cheap; makes the live
      // WS close/open path resolve in ~1s instead of waiting for the next cursor poll.
      for (let attempt = 0; attempt < TX_FETCH_RETRIES && txs.some((t) => t === null); attempt++) {
        await sleep(TX_FETCH_RETRY_MS);
        const missing = signatures.filter((_, i) => txs[i] === null);
        const refetched = await conn.getParsedTransactions(missing, opts);
        let m = 0;
        txs = txs.map((t) => (t === null ? (refetched[m++] ?? null) : t));
      }
      // Any slot STILL null after the retry loop is UNRESOLVED (not "resolved non-DLMM"): the detector must
      // NOT advance the cursor past it — it re-lists and retries until it resolves or a LOUD gap is accepted.
      const unresolved = new Set<string>();
      for (let i = 0; i < signatures.length; i++) {
        const sig = signatures[i];
        if (sig && txs[i] === null) unresolved.add(sig);
      }
      const pools = new Set<string>();
      for (const tx of txs) for (const pl of poolsOf(tx)) pools.add(pl);
      await Promise.all([...pools].map((pl) => getPoolMeta(pl)));
      const poolMeta: PoolMetaLookup = (lbPair) => poolMetaCache.get(lbPair) ?? null;

      const map = new Map<string, DetectedEvent>();
      for (let i = 0; i < signatures.length; i++) {
        const sig = signatures[i];
        if (!sig) continue;
        const e = buildDetectedEvent(sig, txs[i] ?? null, poolMeta);
        if (e) map.set(sig, e);
      }
      const mints = [...new Set([...map.values()].map((e) => e.nonSolMint).filter((m): m is string => !!m))];
      if (mints.length > 0) {
        const metas = await tokenMeta.resolve(mints);
        for (const e of map.values()) {
          if (e.nonSolMint) e.nonSolSymbol = metas.get(e.nonSolMint)?.symbol ?? null;
        }
      }
      return { events: map, unresolved };
    },

    onEvent,
    persist,
    onGap,
  };
}

export const DLMM_LOG_MARKER = DLMM_PROGRAM_ID;
