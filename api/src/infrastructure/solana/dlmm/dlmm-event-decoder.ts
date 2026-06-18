import { utils } from '@coral-xyz/anchor';
import type { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from '@solana/web3.js';
import type { DlmmLeg } from '@/domain/dlmm';
import { DLMM_PROGRAM_ID, dlmmCoder } from './dlmm-coder';

export { DLMM_PROGRAM_ID } from './dlmm-coder';

const bs58 = utils.bytes.bs58;

/**
 * Decodes Meteora DLMM liquidity events from a transaction PURELY from the on-chain Anchor events,
 * driven by the OFFICIAL program IDL (no hand-rolled byte offsets, no Meteora off-chain API).
 *
 * Meteora emits its events via Event CPI (`emit_cpi!`): each event is a self-invocation of the DLMM
 * program carried as an INNER instruction whose data is `[8-byte event-cpi tag][8-byte event disc]
 * [borsh event]`. We read them from `meta.innerInstructions` (NOT `logMessages`, which Solana
 * truncates at 10 KB and silently drops). The 8-byte tag is stripped and the rest handed to Anchor's
 * IDL-driven event coder — so every present and future event variant decodes by name automatically.
 */

const num = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  // anchor decodes u64 as BN
  if (v && typeof (v as { toString: () => string }).toString === 'function')
    return BigInt((v as { toString: () => string }).toString());
  return 0n;
};
const binOf = (data: Record<string, unknown>): number | null => {
  const b = data.active_bin_id ?? data.active_id ?? data.bin_id;
  return b == null ? null : Number(b);
};

/** A raw decoded DLMM event with its host signature/blockTime (before normalization into legs). */
interface RawEvent {
  name: string;
  data: Record<string, unknown>;
  signature: string;
  blockTime: number | null;
}

/** Decode every DLMM Anchor event from a parsed transaction's inner instructions. */
function rawEvents(tx: ParsedTransactionWithMeta): RawEvent[] {
  const out: RawEvent[] = [];
  const signature = tx.transaction.signatures[0] ?? '';
  const blockTime = tx.blockTime ?? null;
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      const pid = 'programId' in ix ? (ix.programId?.toString() ?? '') : '';
      if (pid !== DLMM_PROGRAM_ID) continue;
      const dataB58 = (ix as PartiallyDecodedInstruction).data;
      if (!dataB58) continue;
      let buf: Buffer;
      try {
        buf = Buffer.from(bs58.decode(dataB58));
      } catch {
        continue;
      }
      if (buf.length < 16) continue; // need the 8-byte self-CPI tag + 8-byte event disc
      // strip the self-CPI tag; Anchor's event coder reads the 8-byte event disc + borsh payload.
      const evB64 = Buffer.from(buf.subarray(8)).toString('base64');
      let ev: { name: string; data: Record<string, unknown> } | null;
      try {
        ev = dlmmCoder.events.decode(evB64);
      } catch {
        continue;
      }
      if (ev) out.push({ name: ev.name, data: ev.data, signature, blockTime });
    }
  }
  return out;
}

/**
 * Normalize a transaction's DLMM events into deposit/withdraw/claim legs.
 *
 * - AddLiquidity → one deposit leg (amounts[0]=X, amounts[1]=Y).
 * - RemoveLiquidity → one withdraw leg.
 * - Rebalancing → a withdraw leg (x/y_withdrawn) + a deposit leg (x/y_added) — it pulls liquidity
 *   from old bins and re-adds to new bins; Meteora counts both, so we do too.
 * - ClaimFee2 → one claim leg (fee_x, fee_y) at its own active bin.
 * - ClaimFee (v1) → claim leg, but the event carries NO bin id; we borrow the bin id from a sibling
 *   event in the SAME tx (a v1 claim is always alongside a Remove/Claim2 that has one).
 */
export function decodeDlmmLegs(tx: ParsedTransactionWithMeta): DlmmLeg[] {
  const events = rawEvents(tx);
  if (events.length === 0) return [];
  // a representative bin id for the tx, to backfill events that don't carry one (ClaimFee v1).
  const txBin = events.map((e) => binOf(e.data)).find((b) => b != null) ?? null;
  // ClaimFee (v1) and ClaimFee2 are emitted together for the SAME claim (v2 just added the bin id) —
  // count only one. Prefer ClaimFee2 (carries its own bin id); drop the v1 duplicate when present.
  const hasClaimFee2 = events.some((e) => e.name === 'ClaimFee2');
  const legs: DlmmLeg[] = [];
  for (const e of events) {
    if (e.name === 'ClaimFee' && hasClaimFee2) continue;
    const d = e.data;
    const base = {
      signature: e.signature,
      blockTime: e.blockTime,
      position: String(d.position ?? ''),
      lbPair: String(d.lb_pair ?? ''),
    };
    const bin = binOf(d) ?? txBin;
    if (bin == null) continue; // no price anchor anywhere in the tx → cannot value; skip

    switch (e.name) {
      case 'AddLiquidity': {
        const a = d.amounts as unknown[];
        legs.push({
          ...base,
          kind: 'deposit',
          activeBinId: bin,
          amountX: num(a?.[0]),
          amountY: num(a?.[1]),
        });
        break;
      }
      case 'RemoveLiquidity': {
        const a = d.amounts as unknown[];
        legs.push({
          ...base,
          kind: 'withdraw',
          activeBinId: bin,
          amountX: num(a?.[0]),
          amountY: num(a?.[1]),
        });
        break;
      }
      case 'Rebalancing': {
        const xWd = num(d.x_withdrawn_amount),
          yWd = num(d.y_withdrawn_amount);
        const xAdd = num(d.x_added_amount),
          yAdd = num(d.y_added_amount);
        if (xWd > 0n || yWd > 0n)
          legs.push({ ...base, kind: 'withdraw', activeBinId: bin, amountX: xWd, amountY: yWd });
        if (xAdd > 0n || yAdd > 0n)
          legs.push({ ...base, kind: 'deposit', activeBinId: bin, amountX: xAdd, amountY: yAdd });
        break;
      }
      case 'ClaimFee2':
      case 'ClaimFee': {
        legs.push({
          ...base,
          kind: 'claim',
          activeBinId: bin,
          amountX: num(d.fee_x),
          amountY: num(d.fee_y),
        });
        break;
      }
      default:
        break; // PositionCreate/Close, CompositionFee, rewards, swaps — not capital legs
    }
  }
  return legs;
}
