import { DLMM_PROGRAM_ID } from '@binsight/shared';
import type {
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { classifyTradingByType } from '@/domain/cashflow';
import type { SwapFlowRow, WalletFlowRow } from '@/domain/dlmm';
import {
  type EnhancedTx,
  parseSwapBuy,
  parseSwapSell,
  walletSolFlow,
} from './helius-enhanced';

/**
 * PURE, OFFLINE adapter that re-derives the fields the Helius Enhanced API enriches from a plain
 * Solana `getParsedTransaction` (jsonParsed) result, so the EXISTING Enhanced parsers
 * ({@link parseSwapSell}, {@link parseSwapBuy}, {@link walletSolFlow}) can run on it UNCHANGED.
 *
 * Parity is therefore guaranteed BY CONSTRUCTION: this module never re-implements swap/flow logic, it
 * only reshapes the raw on-chain transaction into the {@link EnhancedTx} the parsers already consume.
 * Eliminating the 100-credit Enhanced call from the live path (Phase A) is a matter of feeding these
 * parsers a getParsedTransaction instead of a Helius payload — nothing downstream changes.
 *
 * Reconstructable from getParsedTransaction: tokenTransfers, nativeTransfers, accountData, instructions
 * (programId only), signature, timestamp. NOT reconstructable: Helius's proprietary `type` taxonomy
 * (SWAP / TRANSFER / ...) — it is a heuristic classification with no on-chain field. We set `type` to a
 * neutral sentinel (see {@link RECONSTRUCTED_TX_TYPE}); the consequence on the trading flag is documented
 * on {@link extractFlowRow}.
 */

/**
 * Helius `type` cannot be derived from raw chain data, so the reconstructed tx carries this sentinel.
 * It deliberately equals pageFlows' own `tx.type ?? 'UNKNOWN'` fallback, so classifyTradingByType falls
 * back to the DLMM-touch signal (the only trading signal we CAN reconstruct) rather than the SWAP type.
 */
const RECONSTRUCTED_TX_TYPE = 'UNKNOWN';

// `program` tags emitted by getParsedTransaction (jsonParsed) for the programs we read. Matching the
// parsed tag is the canonical way to recognise these instructions; an instruction the RPC could not
// parse arrives as PartiallyDecoded (no `parsed`) and carries no movement we can attribute.
const SPL_TOKEN_PROGRAM = 'spl-token';
const SPL_TOKEN_2022_PROGRAM = 'spl-token-2022'; // Token-2022 transfers are equally relevant
const SYSTEM_PROGRAM = 'system';

// SPL-Token instruction variants that move tokens between token accounts.
const SPL_TRANSFER = 'transfer'; // bare: no mint/decimals in the ix → resolved from token balances
const SPL_TRANSFER_CHECKED = 'transferChecked'; // carries mint + decimals in the ix
// System-Program instruction variants that move native SOL between accounts.
const SYS_TRANSFER = 'transfer';
const SYS_TRANSFER_WITH_SEED = 'transferWithSeed';

const TOKEN_DECIMALS_BASE = 10; // raw amount → human amount = raw / 10 ** decimals
const EMPTY_RAW = 0n; // missing pre/post side of a token balance = no tokens on that side

type AnyParsedIx = ParsedInstruction | PartiallyDecodedInstruction;

/** ParsedInstruction type guard (PartiallyDecodedInstruction has no `parsed`/`program`). */
function isParsed(ix: AnyParsedIx): ix is ParsedInstruction {
  return 'parsed' in ix && 'program' in ix;
}

/** The program id of any parsed/partially-decoded instruction, as a base-58 string. */
function programIdOf(ix: AnyParsedIx): string {
  return 'programId' in ix ? (ix.programId?.toString() ?? '') : '';
}

/** Every instruction in execution order: top-level message instructions + all inner (CPI) instructions. */
function allInstructions(tx: ParsedTransactionWithMeta): AnyParsedIx[] {
  const out: AnyParsedIx[] = [...(tx?.transaction?.message?.instructions ?? [])];
  for (const group of tx?.meta?.innerInstructions ?? []) out.push(...group.instructions);
  return out;
}

/** accountKeys[i].pubkey as a string, or undefined when the index is out of range. */
function accountKeyAt(tx: ParsedTransactionWithMeta, index: number): string | undefined {
  return tx?.transaction?.message?.accountKeys?.[index]?.pubkey?.toString();
}

/**
 * Resolve token-account → owner and token-account → {mint, decimals} from pre/postTokenBalances.
 * Each balance entry's `accountIndex` indexes into `accountKeys`, and carries the account's `owner`,
 * `mint`, and `decimals`. This is how we recover the OWNER wallets that Helius reports as
 * from/toUserAccount, and the mint/decimals a bare `transfer` instruction omits.
 */
function buildTokenAccountMaps(tx: ParsedTransactionWithMeta): {
  ownerOf: Map<string, string>;
  mintDecOf: Map<string, { mint: string; decimals: number }>;
} {
  const ownerOf = new Map<string, string>();
  const mintDecOf = new Map<string, { mint: string; decimals: number }>();
  const balances = [
    ...(tx?.meta?.preTokenBalances ?? []),
    ...(tx?.meta?.postTokenBalances ?? []),
  ];
  for (const b of balances) {
    const account = accountKeyAt(tx, b.accountIndex);
    if (account == null) continue;
    if (b.owner != null) ownerOf.set(account, b.owner);
    if (!mintDecOf.has(account))
      mintDecOf.set(account, { mint: b.mint, decimals: b.uiTokenAmount.decimals });
  }
  return { ownerOf, mintDecOf };
}

function toHumanAmount(rawAmount: string | number | undefined, decimals: number): number {
  if (rawAmount == null) return Number.NaN;
  return Number(rawAmount) / TOKEN_DECIMALS_BASE ** decimals;
}

/**
 * Reconstruct {mint, fromUserAccount, toUserAccount, tokenAmount} for every SPL-Token transfer /
 * transferChecked (top-level + inner). from/toUserAccount are the OWNER wallets of the source/destination
 * token accounts (the wallet, not the ATA) — resolved via the owner map, with the instruction `authority`
 * as the source fallback (Helius reports owners; a source ATA is virtually always in preTokenBalances, so
 * the fallback is for pathological inputs only). For a bare `transfer` the ix omits mint+decimals, so they
 * are resolved from the token account's balance entry and the raw amount is decimal-adjusted; an
 * unresolvable bare transfer is skipped (it cannot be attributed to a mint anyway).
 */
function extractTokenTransfers(
  tx: ParsedTransactionWithMeta,
  ownerOf: Map<string, string>,
  mintDecOf: Map<string, { mint: string; decimals: number }>,
): NonNullable<EnhancedTx['tokenTransfers']> {
  const out: NonNullable<EnhancedTx['tokenTransfers']> = [];
  for (const ix of allInstructions(tx)) {
    if (!isParsed(ix)) continue;
    if (ix.program !== SPL_TOKEN_PROGRAM && ix.program !== SPL_TOKEN_2022_PROGRAM) continue;
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    const type = parsed?.type;
    if (type !== SPL_TRANSFER && type !== SPL_TRANSFER_CHECKED) continue;
    const info = parsed?.info ?? {};
    const source = info.source as string | undefined;
    const destination = info.destination as string | undefined;
    if (source == null || destination == null) continue;
    const authority = (info.authority ?? info.multisigAuthority) as string | undefined;
    const fromUserAccount = ownerOf.get(source) ?? authority ?? source;
    const toUserAccount = ownerOf.get(destination) ?? destination;

    let mint: string | undefined;
    let tokenAmount: number;
    if (type === SPL_TRANSFER_CHECKED) {
      mint = info.mint as string | undefined;
      const ta = info.tokenAmount as
        | { amount?: string; decimals?: number; uiAmount?: number | null }
        | undefined;
      tokenAmount =
        ta?.uiAmount != null ? ta.uiAmount : toHumanAmount(ta?.amount, ta?.decimals ?? 0);
    } else {
      // Bare transfer: the ix has only a raw `amount`; recover mint+decimals from the token account.
      const md = mintDecOf.get(source) ?? mintDecOf.get(destination);
      if (md == null) continue; // no mint resolvable → not attributable; skip rather than invent one
      mint = md.mint;
      tokenAmount = toHumanAmount(info.amount as string | undefined, md.decimals);
    }
    if (mint == null || !Number.isFinite(tokenAmount)) continue;
    out.push({ mint, fromUserAccount, toUserAccount, tokenAmount });
  }
  return out;
}

/**
 * Reconstruct {fromUserAccount, toUserAccount, amount(lamports)} for every System-Program transfer /
 * transferWithSeed (top-level + inner). These are the explicit native-SOL movements the parsers net for
 * proceeds when no WSOL leg is present.
 */
function extractNativeTransfers(
  tx: ParsedTransactionWithMeta,
): NonNullable<EnhancedTx['nativeTransfers']> {
  const out: NonNullable<EnhancedTx['nativeTransfers']> = [];
  for (const ix of allInstructions(tx)) {
    if (!isParsed(ix)) continue;
    if (ix.program !== SYSTEM_PROGRAM) continue;
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    const type = parsed?.type;
    if (type !== SYS_TRANSFER && type !== SYS_TRANSFER_WITH_SEED) continue;
    const info = parsed?.info ?? {};
    const source = info.source as string | undefined;
    const destination = info.destination as string | undefined;
    const lamports = info.lamports as number | string | undefined;
    if (source == null || destination == null || lamports == null) continue;
    out.push({ fromUserAccount: source, toUserAccount: destination, amount: Number(lamports) });
  }
  return out;
}

/**
 * Reconstruct each accountKeys[i]'s {account, nativeBalanceChange, tokenBalanceChanges}. nativeBalanceChange
 * is postBalances[i]-preBalances[i]; tokenBalanceChanges are the raw post-pre diffs of the token balances
 * sitting at that account index (matched by accountIndex+mint, unioning pre and post so created/closed
 * accounts are captured), tagged with the OWNER as userAccount — exactly what walletSolFlow reads.
 */
function extractAccountData(tx: ParsedTransactionWithMeta): NonNullable<EnhancedTx['accountData']> {
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const pre = tx?.meta?.preBalances ?? [];
  const post = tx?.meta?.postBalances ?? [];
  const tokenChangesByIndex = buildTokenBalanceChanges(tx);
  const out: NonNullable<EnhancedTx['accountData']> = [];
  for (let i = 0; i < keys.length; i++) {
    const account = keys[i]?.pubkey?.toString();
    if (account == null) continue;
    out.push({
      account,
      nativeBalanceChange: (post[i] ?? 0) - (pre[i] ?? 0),
      tokenBalanceChanges: tokenChangesByIndex.get(i) ?? [],
    });
  }
  return out;
}

/** Per-account-index list of token-balance diffs, matching pre/postTokenBalances by accountIndex+mint. */
function buildTokenBalanceChanges(
  tx: ParsedTransactionWithMeta,
): Map<number, NonNullable<NonNullable<EnhancedTx['accountData']>[number]['tokenBalanceChanges']>> {
  type Acc = {
    accountIndex: number;
    mint: string;
    owner?: string;
    decimals: number;
    preRaw: bigint;
    postRaw: bigint;
  };
  const byKey = new Map<string, Acc>();
  const upsert = (
    entry: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } },
    side: 'pre' | 'post',
  ) => {
    const key = `${entry.accountIndex}:${entry.mint}`;
    const acc = byKey.get(key) ?? {
      accountIndex: entry.accountIndex,
      mint: entry.mint,
      owner: entry.owner,
      decimals: entry.uiTokenAmount.decimals,
      preRaw: EMPTY_RAW,
      postRaw: EMPTY_RAW,
    };
    if (entry.owner != null) acc.owner = entry.owner;
    if (side === 'pre') acc.preRaw = BigInt(entry.uiTokenAmount.amount);
    else acc.postRaw = BigInt(entry.uiTokenAmount.amount);
    byKey.set(key, acc);
  };
  for (const b of tx?.meta?.preTokenBalances ?? []) upsert(b, 'pre');
  for (const b of tx?.meta?.postTokenBalances ?? []) upsert(b, 'post');

  const result = new Map<
    number,
    NonNullable<NonNullable<EnhancedTx['accountData']>[number]['tokenBalanceChanges']>
  >();
  for (const acc of byKey.values()) {
    // userAccount is the OWNER (walletSolFlow keys WSOL by owner); fall back to the token-account address
    // when the RPC omitted owner (it virtually never does for jsonParsed token balances).
    const userAccount = acc.owner ?? accountKeyAt(tx, acc.accountIndex) ?? '';
    const change = {
      userAccount,
      mint: acc.mint,
      rawTokenAmount: {
        tokenAmount: (acc.postRaw - acc.preRaw).toString(),
        decimals: acc.decimals,
      },
    };
    const list = result.get(acc.accountIndex) ?? [];
    list.push(change);
    result.set(acc.accountIndex, list);
  }
  return result;
}

/**
 * Reconstruct the {programId, innerInstructions:[{programId}]} shape — only program ids are needed, they
 * feed the DLMM-touch check. Inner instructions are grouped under their top-level instruction by index.
 */
function extractInstructions(
  tx: ParsedTransactionWithMeta,
): NonNullable<EnhancedTx['instructions']> {
  const top = tx?.transaction?.message?.instructions ?? [];
  const innersByIndex = new Map<number, AnyParsedIx[]>();
  for (const group of tx?.meta?.innerInstructions ?? []) innersByIndex.set(group.index, group.instructions);
  return top.map((ix, i) => ({
    programId: programIdOf(ix),
    innerInstructions: (innersByIndex.get(i) ?? []).map((inner) => ({ programId: programIdOf(inner) })),
  }));
}

/**
 * Mirror of the PRIVATE `touchesDlmm` in helius-enhanced.ts (which cannot be imported). Identical logic
 * over the reconstructed instructions, so the trading classification matches pageFlows by construction.
 */
function touchesDlmm(tx: EnhancedTx): boolean {
  for (const ix of tx.instructions ?? []) {
    if (ix.programId === DLMM_PROGRAM_ID) return true;
    for (const inner of ix.innerInstructions ?? [])
      if (inner.programId === DLMM_PROGRAM_ID) return true;
  }
  return false;
}

/**
 * Reshape a `getParsedTransaction` (jsonParsed) result into the {@link EnhancedTx} the Helius parsers
 * consume. Defensive against missing/null meta and a malformed/empty tx (returns empty arrays, never
 * throws). `type` is the {@link RECONSTRUCTED_TX_TYPE} sentinel — see the module JSDoc.
 */
export function parsedTxToEnhancedTx(tx: ParsedTransactionWithMeta): EnhancedTx {
  const { ownerOf, mintDecOf } = buildTokenAccountMaps(tx);
  return {
    signature: tx?.transaction?.signatures?.[0] ?? '',
    timestamp: tx?.blockTime ?? 0,
    type: RECONSTRUCTED_TX_TYPE,
    tokenTransfers: extractTokenTransfers(tx, ownerOf, mintDecOf),
    nativeTransfers: extractNativeTransfers(tx),
    accountData: extractAccountData(tx),
    instructions: extractInstructions(tx),
  };
}

/**
 * Derive the wallet's clean swap leg(s) from a parsed tx — run parseSwapSell + parseSwapBuy on the
 * reconstructed EnhancedTx, mapped to the SAME {@link SwapFlowRow} rows `pageSwaps` produces (sell →
 * side 'sell', solAmount = SOL received; buy → side 'buy', solAmount = SOL spent). A clean SWAP matches
 * at most one parser, so a tx yields 0 or 1 rows; an unattributable tx (batched/multi-mint) yields none.
 */
export function extractSwapRows(tx: ParsedTransactionWithMeta, wallet: string): SwapFlowRow[] {
  const enhanced = parsedTxToEnhancedTx(tx);
  const rows: SwapFlowRow[] = [];
  const sell = parseSwapSell(enhanced, wallet);
  if (sell)
    rows.push({
      wallet,
      signature: enhanced.signature,
      ts: sell.ts,
      mint: sell.mint,
      tokenAmount: sell.tokenAmount,
      solAmount: sell.solReceived, // SOL received for the sell
      side: 'sell',
    });
  const buy = parseSwapBuy(enhanced, wallet);
  if (buy)
    rows.push({
      wallet,
      signature: enhanced.signature,
      ts: buy.ts,
      mint: buy.mint,
      tokenAmount: buy.tokenAmount,
      solAmount: buy.solReceived, // = SOL spent on the buy (parseSwapBuy returns it as solReceived)
      side: 'buy',
    });
  return rows;
}

/**
 * Derive the wallet's single `pageFlows` row from a parsed tx: net SOL flow (walletSolFlow) + the trading
 * flag (classifyTradingByType), tagged with signature + timestamp. Returns null for a degenerate tx with
 * no metadata (nothing reliable to reduce) or no signature (nothing to key a row on); for any real tx —
 * including a plain external transfer — it emits a row, exactly as pageFlows does.
 *
 * KNOWN GAP: classifyTradingByType's `type === 'SWAP'` branch cannot fire here because Helius's `type` is
 * not reconstructable offline (see module JSDoc); the trading flag is driven PURELY by the DLMM-touch
 * signal. For DLMM lifecycle txs (the live ingestion target) this is exact; a plain non-DLMM swap that
 * Helius would label 'SWAP' (isTrading=true) is classified isTrading=false here. The orchestrator must
 * cover SWAP classification separately when wiring this onto the wallet-flow curve.
 */
export function extractFlowRow(tx: ParsedTransactionWithMeta, wallet: string): WalletFlowRow | null {
  if (tx?.meta == null) return null; // no metadata → nothing reliable to reduce into a flow row
  const enhanced = parsedTxToEnhancedTx(tx);
  if (!enhanced.signature) return null;
  return {
    signature: enhanced.signature,
    timestamp: enhanced.timestamp,
    type: enhanced.type,
    solFlow: walletSolFlow(enhanced, wallet),
    isTrading: classifyTradingByType(enhanced.type, touchesDlmm(enhanced)),
  };
}
