import { createHash } from 'node:crypto';
import { utils } from '@coral-xyz/anchor';
import type { PositionEvent, PositionEventKind, PositionHistory } from '@meteora/shared';
import type {
  Connection,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { DLMM_PROGRAM_ID, decodeLbPair, LBPAIR_DISC } from './layout';

/** base58 decode for instruction data; throws on a non-base58 character. */
const bs58 = (s: string): Uint8Array => utils.bytes.bs58.decode(s);

const discMatches = (b: Uint8Array, d: readonly number[]): boolean => d.every((v, i) => b[i] === v);

/** Anchor instruction discriminator = sha256("global:<snake_name>")[:8], hex. */
const disc = (name: string): string =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');

/**
 * Maps each relevant DLMM instruction (all known variants) to a timeline event kind.
 * Discriminators are derived deterministically and were validated byte-exact against real
 * on-chain transactions + the datapi aggregates (see discover-history.spike.ts).
 */
const KIND_BY_DISC = new Map<string, PositionEventKind>();
const define = (kind: PositionEventKind, names: string[]): void => {
  for (const n of names) KIND_BY_DISC.set(disc(n), kind);
};
define('open', [
  'initialize_position',
  'initialize_position_pda',
  'initialize_position_by_operator',
]);
define('deposit', [
  'add_liquidity',
  'add_liquidity_by_weight',
  'add_liquidity_by_strategy',
  'add_liquidity_by_strategy_one_side',
  'add_liquidity_one_side_precise',
  'add_liquidity2',
  'add_liquidity_by_strategy2',
  'add_liquidity_one_side_precise2',
]);
define('withdraw', [
  'remove_liquidity',
  'remove_liquidity_by_range',
  'remove_liquidity2',
  'remove_liquidity_by_range2',
  'remove_all_liquidity',
]);
define('claim', ['claim_fee', 'claim_fee2']);
define('close', ['close_position', 'close_position2', 'close_position_if_empty']);

const DLMM = DLMM_PROGRAM_ID.toBase58();
const SIG_PAGE = 1000;
const MAX_PAGES = 20;

const isDlmm = (ix: { programId: PublicKey }): boolean => ix.programId.toBase58() === DLMM;
const discOf = (ix: PartiallyDecodedInstruction): string =>
  Buffer.from(bs58(ix.data)).subarray(0, 8).toString('hex');

type Pool = { tokenXMint: string; tokenYMint: string; decX: number; decY: number };

/**
 * Reconstructs a position's full event timeline (open / deposit / withdraw / claim / close) from
 * its on-chain transaction history via Helius. Works for closed positions too (the position
 * account may be gone, but its transactions and the lb_pair account persist). Returns null when
 * the address has no transaction history. No LPAgent dependency.
 */
export async function fetchPositionHistory(
  conn: Connection,
  positionAddress: string,
): Promise<PositionHistory | null> {
  const pk = new PublicKey(positionAddress);
  const signatures = await allSignatures(conn, pk);
  if (signatures.length === 0) return null;

  let pool: Pool | null = null;
  const events: PositionEvent[] = [];

  for (const sig of signatures) {
    const tx = await conn.getParsedTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx) continue;
    const at = (tx.blockTime ?? 0) * 1000;
    const top = tx.transaction.message.instructions;

    for (let i = 0; i < top.length; i++) {
      const ix = top[i]!;
      if (!isDlmm(ix) || !('data' in ix)) continue;
      const kind = KIND_BY_DISC.get(discOf(ix));
      if (!kind) continue;

      pool ??= await resolvePool(conn, ix);
      if (!pool) continue;

      const transfers = transfersForInstruction(tx, i);
      let amountX = 0;
      let amountY = 0;
      for (const t of transfers) {
        if (t.mint === pool.tokenXMint) amountX += Number(t.amount) / 10 ** pool.decX;
        else if (t.mint === pool.tokenYMint) amountY += Number(t.amount) / 10 ** pool.decY;
      }
      events.push({ kind, at, signature: sig, amountX, amountY });
    }
  }

  if (!pool) return null;
  return {
    positionAddress,
    tokenXMint: pool.tokenXMint,
    tokenYMint: pool.tokenYMint,
    events,
  };
}

/** All confirmed signatures touching the position account, oldest → newest. */
async function allSignatures(conn: Connection, pk: PublicKey): Promise<string[]> {
  const out: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await conn.getSignaturesForAddress(pk, { before, limit: SIG_PAGE }, 'confirmed');
    if (batch.length === 0) break;
    for (const s of batch) out.push(s.signature);
    before = batch[batch.length - 1]!.signature;
    if (batch.length < SIG_PAGE) break;
  }
  return out.reverse();
}

/** Find the lb_pair among the instruction's accounts (by discriminator) and decode pool mints + decimals. */
async function resolvePool(
  conn: Connection,
  ix: PartiallyDecodedInstruction,
): Promise<Pool | null> {
  const infos = await conn.getMultipleAccountsInfo(ix.accounts, 'confirmed');
  const lbPair = infos.find((info) => info && discMatches(info.data, LBPAIR_DISC));
  if (!lbPair) return null;
  const { tokenXMint, tokenYMint } = decodeLbPair(lbPair.data);
  const [decX, decY] = await Promise.all([
    decimalsOf(conn, tokenXMint),
    decimalsOf(conn, tokenYMint),
  ]);
  return { tokenXMint: tokenXMint.toBase58(), tokenYMint: tokenYMint.toBase58(), decX, decY };
}

async function decimalsOf(conn: Connection, mint: PublicKey): Promise<number> {
  const info = await conn.getAccountInfo(mint, 'confirmed');
  return info ? info.data[44]! : 0; // SPL Mint: decimals @ offset 44
}

/** SPL token transfers nested under the top-level instruction at `index` (by innerInstructions.index). */
function transfersForInstruction(
  tx: ParsedTransactionWithMeta,
  index: number,
): Array<{ amount: string; mint?: string }> {
  const out: Array<{ amount: string; mint?: string }> = [];
  for (const grp of tx.meta?.innerInstructions ?? []) {
    if (grp.index !== index) continue;
    for (const ix of grp.instructions) {
      if (!('parsed' in ix) || ix.program !== 'spl-token') continue;
      const p = ix.parsed as { type?: string; info?: Record<string, unknown> };
      if (p.type !== 'transfer' && p.type !== 'transferChecked') continue;
      const info = p.info ?? {};
      const amount =
        (info.amount as string) ?? (info.tokenAmount as { amount?: string })?.amount ?? '0';
      out.push({ amount, mint: info.mint as string | undefined });
    }
  }
  return out;
}
