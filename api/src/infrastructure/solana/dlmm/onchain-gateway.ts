import {
  type PositionBins,
  type PositionHistory,
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  USDT_MINT,
} from '@binsight/shared';
import { utils } from '@coral-xyz/anchor';
import {
  type AccountInfo,
  type Connection,
  type GetProgramAccountsFilter,
  PublicKey,
} from '@solana/web3.js';
import type { OnchainPositionValue, OnchainWalletSnapshot, SnapshotPlan } from '@/domain/dlmm';
import type { OnchainDlmmGateway as OnchainDlmmGatewayPort } from '@/domain/ports';
import { buildGpaV2Params, GPA_V2_PAGE_LIMIT, parseGpaV2Response, type RawRpc } from './gpa-v2';
import {
  DLMM_PROGRAM_ID,
  decodeLbPair,
  decodePosition,
  decodePositionHeader,
  deriveBinArray,
  POSITION_V2_DISC,
  POSITION_V2_OWNER_OFFSET,
} from './layout';
import { fetchPositionBins } from './position-detail';
import { fetchPositionHistory } from './position-history';
import { coverageIndices, valuePosition } from './valuation';

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM = new PublicKey(TOKEN_PROGRAM_ID);
const GMA_CHUNK = 100;
const HISTORY_TTL_MS = 60_000; // open positions may still accrue events; closed are immutable
const HISTORY_MAX = 5000; // bound the cache: closed entries have no TTL, so cap total + FIFO-evict

/** base58 encode of a byte array (for getProgramAccounts memcmp filters). */
const minimalBase58 = (b: Uint8Array): string => utils.bytes.bs58.encode(b);

const u64le = (b: Uint8Array, o: number): bigint => {
  let r = 0n;
  for (let i = 7; i >= 0; i--) r = (r << 8n) | BigInt(b[o + i]!);
  return r;
};

/**
 * 100%-on-chain DLMM wallet snapshot. Discovers a wallet's positions (getProgramAccountsV2 owner@40),
 * then values every position + reads native SOL + stable ATAs in ONE pinned getMultipleAccounts pass
 * so the whole total is internally consistent (no two-clock double-counting). Validated byte-exact
 * vs the datapi (see verify.spike.ts / backend-validation-report.md §1).
 */
export class OnchainDlmmGateway implements OnchainDlmmGatewayPort {
  private readonly decimalsCache = new Map<string, number>();
  private readonly historyCache = new Map<
    string,
    { hist: PositionHistory; at: number; closed: boolean }
  >();

  // Raw JSON-RPC caller for methods web3.js's Connection has no typed helper for (getProgramAccountsV2).
  // Defaults to the Connection's internal `_rpcRequest`, which routes through the SAME fetch middleware as
  // every other call — so the rate-limiter + CreditMeter still meter it (method 'getProgramAccountsV2' →
  // 1 credit). Injectable so the gateway is unit-tested with a spy (no network).
  private readonly rawRpc: RawRpc;

  constructor(
    private readonly conn: Connection,
    rawRpc?: RawRpc,
  ) {
    this.rawRpc =
      rawRpc ??
      ((method, params) =>
        (conn as unknown as { _rpcRequest(m: string, a: unknown[]): Promise<unknown> })._rpcRequest(
          method,
          params,
        ));
  }

  deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];
  }

  /**
   * getProgramAccountsV2 → just the position pubkeys for this owner (pubkeys only, cheap). Paginates the
   * 1-credit V2 method (the legacy getProgramAccounts was 10 credits) over the SAME metered Connection,
   * with the identical owner-memcmp + position-discriminator filters → byte-identical result set.
   *
   * DEFERRED (no-miss): `changedSinceSlot` (incremental discovery) is supported by the builder but NOT
   * wired here — a delta-only discovery would drop unchanged-but-still-open positions unless merged
   * against a durable cached set. We do a FULL paginated discovery (gated by the engine's Layer-A so it
   * only runs on a position-SET change), keeping discovery results identical to the legacy path.
   */
  private async discover(owner: string): Promise<PublicKey[]> {
    const filters: GetProgramAccountsFilter[] = [
      { memcmp: { offset: 0, bytes: minimalBase58(Uint8Array.from(POSITION_V2_DISC)) } },
      { memcmp: { offset: POSITION_V2_OWNER_OFFSET, bytes: owner } },
    ];
    const programId = DLMM_PROGRAM_ID.toBase58();
    const pubkeys: PublicKey[] = [];
    let paginationKey: string | null = null;
    do {
      const params = buildGpaV2Params(programId, {
        filters,
        dataSlice: { offset: 0, length: 0 },
        commitment: 'confirmed',
        limit: GPA_V2_PAGE_LIMIT,
        paginationKey,
      });
      const page = parseGpaV2Response(await this.rawRpc('getProgramAccountsV2', params));
      for (const pk of page.pubkeys) pubkeys.push(new PublicKey(pk));
      paginationKey = page.paginationKey;
    } while (paginationKey !== null);
    return pubkeys;
  }

  /** Chunked getMultipleAccounts pinned to one target slot. Returns infos in key order + slot skew. */
  private async fetchAtSlot(
    keys: PublicKey[],
  ): Promise<{ slot: number; skew: number; infos: (AccountInfo<Buffer> | null)[] }> {
    const infos: (AccountInfo<Buffer> | null)[] = new Array(keys.length).fill(null);
    if (keys.length === 0) return { slot: 0, skew: 0, infos };
    let target: number | undefined;
    let minSlot = Number.POSITIVE_INFINITY;
    let maxSlot = 0;
    for (let i = 0; i < keys.length; i += GMA_CHUNK) {
      const chunk = keys.slice(i, i + GMA_CHUNK);
      let res = await this.conn.getMultipleAccountsInfoAndContext(chunk, {
        commitment: 'confirmed',
        minContextSlot: target,
      });
      for (
        let attempt = 0;
        attempt < 5 && target !== undefined && res.context.slot !== target;
        attempt++
      ) {
        target = res.context.slot; // chunk advanced past target — bump and retry to re-converge
        res = await this.conn.getMultipleAccountsInfoAndContext(chunk, {
          commitment: 'confirmed',
          minContextSlot: target,
        });
      }
      if (target === undefined) target = res.context.slot;
      res.value.forEach((v, j) => {
        infos[i + j] = v;
      });
      minSlot = Math.min(minSlot, res.context.slot);
      maxSlot = Math.max(maxSlot, res.context.slot);
    }
    return { slot: maxSlot, skew: maxSlot - minSlot, infos };
  }

  private async decimalsFor(mints: PublicKey[]): Promise<void> {
    const missing = mints.filter((m) => !this.decimalsCache.has(m.toBase58()));
    if (missing.length === 0) return;
    for (let i = 0; i < missing.length; i += GMA_CHUNK) {
      const chunk = missing.slice(i, i + GMA_CHUNK);
      const infos = await this.conn.getMultipleAccountsInfo(chunk, 'confirmed');
      infos.forEach((info, j) => {
        // SPL Mint: decimals @ offset 44 (works for Token & Token-2022 base layout). A NULL info is a
        // transient RPC miss (429 / not-yet-visible mint) — do NOT cache it: a one-off blip would pin
        // this mint's decimals at 0 forever and mis-value every later residual conversion. Leaving it
        // unset lets the next call retry; until then decimalsOf falls back to 0 for this call only.
        if (info) this.decimalsCache.set(chunk[j]!.toBase58(), info.data[44]!);
      });
    }
  }

  /** Token decimals for one mint (cached). Converts a UI residual amount to raw for a Jupiter quote. */
  async decimalsOf(mint: string): Promise<number> {
    await this.decimalsFor([new PublicKey(mint)]);
    return this.decimalsCache.get(mint) ?? 0;
  }

  /** Per-bin liquidity distribution of one open position (for the Price-Bin histogram). */
  positionBins(positionAddress: string): Promise<PositionBins | null> {
    return fetchPositionBins(this.conn, (m) => this.decimalsOf(m), positionAddress);
  }

  /** On-chain event timeline of a position (History drawer). Cached: closed forever, open 60s. */
  async positionHistory(positionAddress: string): Promise<PositionHistory | null> {
    const hit = this.historyCache.get(positionAddress);
    if (hit && (hit.closed || Date.now() - hit.at < HISTORY_TTL_MS)) return hit.hist;
    const hist = await fetchPositionHistory(this.conn, positionAddress);
    if (hist) {
      const closed = hist.events.some((e) => e.kind === 'close');
      // Bound the (otherwise unbounded) cache: closed histories carry no TTL, so cap the total and
      // FIFO-evict the oldest. An evicted entry is simply re-fetched on its next miss (immutable).
      if (this.historyCache.size >= HISTORY_MAX && !this.historyCache.has(positionAddress)) {
        const oldest = this.historyCache.keys().next().value;
        if (oldest !== undefined) this.historyCache.delete(oldest);
      }
      this.historyCache.set(positionAddress, { hist, at: Date.now(), closed });
    }
    return hist;
  }

  async snapshotWallet(
    ownerStr: string,
    cachedPlan?: SnapshotPlan,
  ): Promise<OnchainWalletSnapshot & { plan: SnapshotPlan }> {
    const owner = new PublicKey(ownerStr);
    // Layer A: reuse a cached discovery plan when the position set/ranges haven't changed (the engine
    // invalidates it on WS open/close/add/remove), skipping the getProgramAccountsV2 discovery AND the
    // round-1 header read. The round-2 valuation below is byte-identical either way.
    const plan = cachedPlan ?? (await this.buildPlan(ownerStr));
    const { positionKeys, lbPairByPos, coverageByPos, lbPairKeys, binArrayKeys, binArrayMeta } =
      plan;

    const ataMints = [SOL_MINT, USDC_MINT, USDT_MINT].map((m) => new PublicKey(m));
    const ataKeys = ataMints.map((m) => this.deriveAta(owner, m));

    // Round 2: ONE pinned pass — positions + lbPairs + binArrays + wallet (native) + stable ATAs.
    const allKeys = [...positionKeys, ...lbPairKeys, ...binArrayKeys, owner, ...ataKeys];
    const { slot, skew, infos } = await this.fetchAtSlot(allKeys);

    const nPos = positionKeys.length;
    const nLb = lbPairKeys.length;
    const nBa = binArrayKeys.length;
    const posInfos = infos.slice(0, nPos);
    const lbInfos = infos.slice(nPos, nPos + nLb);
    const baInfos = infos.slice(nPos + nLb, nPos + nLb + nBa);
    const walletInfo = infos[nPos + nLb + nBa];
    const ataInfos = infos.slice(nPos + nLb + nBa + 1);

    const lbByKey = new Map<string, ReturnType<typeof decodeLbPair>>();
    lbPairKeys.forEach((k, i) => {
      const info = lbInfos[i];
      if (info) lbByKey.set(k.toBase58(), decodeLbPair(info.data));
    });
    const baByMeta = new Map<string, Uint8Array>();
    binArrayMeta.forEach((m, i) => {
      const info = baInfos[i];
      if (info) baByMeta.set(`${m.lbPair}:${m.index}`, info.data);
    });

    // decimals for all involved mints
    const mintSet = new Map<string, PublicKey>();
    for (const lb of lbByKey.values()) {
      mintSet.set(lb.tokenXMint.toBase58(), lb.tokenXMint);
      mintSet.set(lb.tokenYMint.toBase58(), lb.tokenYMint);
    }
    await this.decimalsFor([...mintSet.values()]);

    const positions: OnchainPositionValue[] = [];
    // Track whether the chain read fully covered every held position. An under/over-stated snapshot
    // (missing pool data, unfetched bin-array, unknown decimals) must NOT be persisted as a real Net
    // Worth point — it surfaces as `complete: false` → freshness 'syncing' → skipped by the recorder.
    let complete = true;
    positionKeys.forEach((pk, i) => {
      const info = posInfos[i];
      if (!info) return; // position account absent → closed between rounds (benign; not a data miss)
      const lbPair = lbPairByPos.get(pk.toBase58());
      const lb = lbPair && lbByKey.get(lbPair.toBase58());
      if (!lbPair || !lb) {
        // The position exists on-chain but its pool (lbPair) data wasn't read — its value would be
        // dropped, deflating the total. Flag incomplete rather than silently under-count.
        complete = false;
        return;
      }
      const pos = decodePosition(info.data);
      const baMap = new Map<number, Uint8Array | null>();
      for (const idx of coverageByPos.get(pk.toBase58()) ?? []) {
        baMap.set(idx, baByMeta.get(`${lbPair.toBase58()}:${idx}`) ?? null);
      }
      const v = valuePosition(pos, baMap);
      if (!v.complete) complete = false; // a share>0 bin's bin-array was absent → amounts under-counted
      const dX = this.decimalsCache.get(lb.tokenXMint.toBase58());
      const dY = this.decimalsCache.get(lb.tokenYMint.toBase58());
      // R23: a NULL decimals (transient RPC miss — deliberately not cached) makes ui(amount,0) =
      // Number(amount), inflating a 6/9-dp token by 10^6–10^9. Flag incomplete instead of persisting
      // the mis-scaled amount; the next snapshot retries the mint and resolves it.
      if (dX === undefined || dY === undefined) complete = false;
      positions.push({
        positionAddress: pk.toBase58(),
        lbPair: lbPair.toBase58(),
        tokenXMint: lb.tokenXMint.toBase58(),
        tokenYMint: lb.tokenYMint.toBase58(),
        amountX: v.amountX,
        amountY: v.amountY,
        feeX: v.feeX,
        feeY: v.feeY,
        decimalsX: dX ?? 0,
        decimalsY: dY ?? 0,
        activeId: lb.activeId,
        binStep: lb.binStep,
        lowerBinId: pos.lowerBinId,
        upperBinId: pos.upperBinId,
        lamports: BigInt(info.lamports),
      });
    });

    const idleTokens: OnchainWalletSnapshot['idleTokens'] = [];
    const stableDecimals: Record<string, number> = {
      [SOL_MINT]: 9,
      [USDC_MINT]: 6,
      [USDT_MINT]: 6,
    };
    ataInfos.forEach((info, i) => {
      if (!info || info.data.length < 72) return;
      const amount = u64le(info.data, 64); // SPL token account: amount @ offset 64
      if (amount <= 0n) return;
      const mint = ataMints[i]!.toBase58();
      idleTokens.push({ mint, amount, decimals: stableDecimals[mint] ?? 0 });
    });

    return {
      owner: ownerStr,
      slot,
      slotSkew: skew,
      nativeLamports: walletInfo ? BigInt(walletInfo.lamports) : 0n,
      idleTokens,
      positions,
      complete,
      plan,
    };
  }

  /** Discovery (getProgramAccountsV2) + round-1 header read → the cacheable snapshot plan. */
  private async buildPlan(ownerStr: string): Promise<SnapshotPlan> {
    const positionKeys = await this.discover(ownerStr);
    const headers = (await this.fetchAtSlot(positionKeys)).infos;
    const lbPairByPos = new Map<string, PublicKey>();
    const coverageByPos = new Map<string, number[]>();
    const lbPairSet = new Map<string, PublicKey>();
    const binArrayKeys: PublicKey[] = [];
    const binArrayMeta: { lbPair: string; index: number }[] = [];
    positionKeys.forEach((pk, i) => {
      const info = headers[i];
      if (!info) return;
      const h = decodePositionHeader(info.data);
      const lb = h.lbPair.toBase58();
      lbPairByPos.set(pk.toBase58(), h.lbPair);
      lbPairSet.set(lb, h.lbPair);
      const idxs = coverageIndices(h.lowerBinId, h.upperBinId);
      coverageByPos.set(pk.toBase58(), idxs);
      for (const idx of idxs) {
        binArrayKeys.push(deriveBinArray(h.lbPair, idx));
        binArrayMeta.push({ lbPair: lb, index: idx });
      }
    });
    return {
      positionKeys,
      lbPairByPos,
      coverageByPos,
      lbPairKeys: [...lbPairSet.values()],
      binArrayKeys,
      binArrayMeta,
    };
  }
}
