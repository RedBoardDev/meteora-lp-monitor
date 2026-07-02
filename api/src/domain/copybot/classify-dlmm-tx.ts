/**
 * Copy-bot · P1 — PURE part of classifying a tx (extracted from `watch-leader.ts` `classify()`).
 *
 * Given a parsed transaction + a SYNCHRONOUS pool-meta lookup (already loaded), produces the
 * `DetectedEvent` valued in SOL — or `null` if it isn't a DLMM tx. Leg routing (deposit →
 * `depositSol`, withdraw → `withdrawSol`, claim → `claimSol`) and the pool's non-SOL side live HERE, so they
 * are tested WITHOUT the network (cf. `classify-dlmm-tx.test.ts`, golden on open/close/claim/partial withdrawal).
 *
 * The non-SOL token's symbol is resolved elsewhere (batched I/O call in `watch-leader.ts`) → `nonSolSymbol`
 * stays `null` here. The byte decoding itself remains the binsight engine (`decodeDlmmLegs`, tested against
 * the real Event-CPI layout in `dlmm-event-decoder.test.ts`).
 */
import { SOL_MINT } from '@binsight/shared';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import type { DetectedEvent } from './events';
import type { LoadedPoolMeta } from '../dlmm';
import { legValueSol } from '../dlmm-pnl';
import { decodeDlmmLegs, hasDlmmEvents } from '../../infrastructure/solana/dlmm/dlmm-event-decoder';
import { parseInstruction } from '../../infrastructure/solana/helius-subscriber';

/** Synchronous pool→meta lookup (already loaded). `null` = unknown pool or not valuable in SOL. */
export type PoolMetaLookup = (lbPair: string) => LoadedPoolMeta | null;

/** The pools (lbPair) touched by a tx — used to pre-load the metas (I/O) BEFORE the pure call. */
export function poolsOf(tx: ParsedTransactionWithMeta | null): string[] {
  if (!tx) return [];
  return [...new Set(decodeDlmmLegs(tx).map((l) => l.lbPair))];
}

/**
 * Builds the `DetectedEvent` of ONE tx. `null` if it isn't a DLMM tx (no tx, or no DLMM Event-CPI). A pool
 * that is present but not valuable in SOL (`solSide === null` / meta absent) keeps the action with amounts at
 * 0 and `nonSolMint = null` — we never lose the event, we only lose the amount.
 *
 * DLMM-ness is gated on the decoded events (`hasDlmmEvents`), NOT on `logMessages`: Solana truncates logs at
 * 10KB, so a DLMM instruction that runs after a big bundle (e.g. a Jupiter zap) has no DLMM string in the
 * truncated logs — gating on logs would return null and PERMANENTLY MISS that leader open/close. `instruction`
 * stays a best-effort LABEL from the logs (`'(DLMM)'` when truncated); routing keys off `closed`, not the label.
 */
export function buildDetectedEvent(
  signature: string,
  tx: ParsedTransactionWithMeta | null,
  poolMeta: PoolMetaLookup,
): DetectedEvent | null {
  if (!tx || !hasDlmmEvents(tx)) return null;

  const instruction = parseInstruction(tx.meta?.logMessages ?? []) ?? '(DLMM)';
  let depositSol = 0;
  let depositTokenRaw = 0; // raw NON-SOL units deposited — authoritative two-sided signal (decode, not the shape read)
  let withdrawSol = 0;
  let claimSol = 0;
  let closed = false; // a decoded 'close' leg (PositionClose) → robust close signal, independent of the log label
  let pool = '';
  let position = '';
  let nonSolMint: string | null = null;
  for (const leg of decodeDlmmLegs(tx)) {
    if (leg.kind === 'close') closed = true; // PositionClose leg → the leader closed the position
    if (leg.lbPair) pool = leg.lbPair; // a zero-amount close marker carries no pool → don't clobber the real one
    if (leg.position) position = leg.position; // P2 tracker key; legs of the same tx share the position
    const meta = poolMeta(leg.lbPair);
    if (!meta || !meta.solSide) continue; // pool not valuable in SOL → action kept, without amount
    nonSolMint = meta.mintX === SOL_MINT ? meta.mintY : meta.mintX;
    const sol = legValueSol(leg, { binStep: meta.binStep, solSide: meta.solSide });
    if (leg.kind === 'deposit') {
      depositSol += sol;
      depositTokenRaw += Number(meta.mintX === SOL_MINT ? leg.amountY : leg.amountX); // the non-SOL leg's raw amount
    } else if (leg.kind === 'withdraw') withdrawSol += sol;
    else claimSol += sol;
  }

  return {
    signature,
    blockTime: tx.blockTime ?? null,
    instruction,
    depositSol,
    depositTokenRaw,
    withdrawSol,
    claimSol,
    closed,
    pool,
    position,
    nonSolMint,
    nonSolSymbol: null,
  };
}
