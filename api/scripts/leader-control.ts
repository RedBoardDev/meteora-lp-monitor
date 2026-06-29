/**
 * Copy-bot · TEST TOOL — drives the LEADER-TEST wallet (≈ a human leader we control): opens / closes
 * a DLMM position, collects fees, on a SOL/USDC pool, on demand. Used to trigger the full lifecycle
 * to test the bot WITHOUT waiting for the real leader. Holds the leader-test key (test tool, outside the
 * bot's brain/coffre zones). Bundled CJS (SDK):
 *   yarn bot:build → node --env-file=../.env dist/copybot/scripts/leader-control.cjs <pools|status|open|close|claim> [--pool=P] [--sol=0.1]
 */
import { readFileSync } from 'node:fs';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, type Signer, Transaction } from '@solana/web3.js';
import { planWalletSweep } from '../src/domain/copybot/residual-sell';
import { reanchorShape } from '../src/domain/copybot/reanchor';
import { type WeightBin, buildAddByStrategy, buildAddByStrategyTwoSided, buildAddByWeight, buildClaimTx, buildCloseTx, buildOpenByStrategy, buildOpenByStrategyTwoSided, buildOpenByWeight, buildRemovePartial, createDlmmPair, strategyTypeFromName } from '../src/infrastructure/solana/dlmm/dlmm-tx-builder';
import { readLeaderPositionShape, readUserPositions } from '../src/infrastructure/solana/dlmm/leader-position-reader';
import { OnchainPoolMetaReader } from '../src/infrastructure/solana/dlmm/pool-meta';
import { DEFAULT_JUPITER_BASE_URL, WSOL_MINT, buildJupiterSwapTx, getJupiterBuyQuoteExactIn, getJupiterQuote } from '../src/infrastructure/solana/jupiter/jupiter-swap-builder';
import { readAllOwnerTokenBalances } from '../src/infrastructure/solana/token-balance-reader';

const JUPITER_BASE = process.env.JUPITER_BASE_URL ?? DEFAULT_JUPITER_BASE_URL;
const SWEEP_SLIPPAGE_BPS = 100; // 1% — test-tool wallet sweep tolerance

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WIDTH_BINS = 8;

const conn = new Connection(process.env.SOLANA_HTTP_URL ?? '', 'confirmed');
const leader = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.wallets/leader-test.json', 'utf8'))));
const arg = (name: string): string | undefined => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a?.slice(name.length + 3);
};

const ownerTokenRaw = async (mint: string): Promise<bigint> => (await readAllOwnerTokenBalances(conn, leader.publicKey)).find((b) => b.mint === mint)?.amountRaw ?? 0n;

/** Buy ~`tokenRaw` of `tokenMint` with SOL via ExactIn, returning the ACTUAL amount acquired. ExactOut has NO Jupiter
 *  route for most Token-2022 memecoins (NO_ROUTES_FOUND → http 400), so we price the target via the SELL direction
 *  (fully routed) then spend that SOL via ExactIn (output is variable → deposit the real balance delta, not a target). */
async function buyTokenExactIn(tokenMint: string, tokenRaw: bigint): Promise<bigint> {
  const before = await ownerTokenRaw(tokenMint);
  const priceQ = await getJupiterQuote(JUPITER_BASE, tokenMint, tokenRaw, SWEEP_SLIPPAGE_BPS); // value tokenRaw in SOL
  const q = await getJupiterBuyQuoteExactIn(JUPITER_BASE, tokenMint, BigInt(priceQ.outAmount), SWEEP_SLIPPAGE_BPS);
  const buyTx = await buildJupiterSwapTx(JUPITER_BASE, q, leader.publicKey.toBase58());
  await signLandConfirm(Transaction.from(Buffer.from(buyTx, 'base64')));
  const bought = (await ownerTokenRaw(tokenMint)) - before;
  console.log(`🟣 BUY (ExactIn) ${bought} ${tokenMint} cost~${Number(q.inAmount) / 1e9} SOL`);
  return bought;
}

async function signLandConfirm(txOrArr: Transaction | Transaction[], extra: Signer[] = []): Promise<string[]> {
  const txs = Array.isArray(txOrArr) ? txOrArr : [txOrArr];
  const sigs: string[] = [];
  for (const tx of txs) {
    // Force an explicit CU limit: wide positions (e.g. a 17-bin two-sided open/close) exceed the 200k default and
    // the tx silently fails on-chain → never confirms → "block height exceeded". 400k covers them.
    tx.instructions = tx.instructions.filter((ix) => ix.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111');
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.feePayer = leader.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(leader, ...extra);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    sigs.push(sig);
  }
  return sigs;
}

async function poolMeta(pool: string) {
  const meta = await new OnchainPoolMetaReader(conn).loadPoolMeta(pool);
  if (!meta?.solSide) throw new Error(`pool ${pool} not SOL-paired`);
  return meta;
}

const WEIGHT_SCALE = 1_000_000; // scale CLI weights to raw synthetic amounts for the (tested) reanchor BPS math

/**
 * Build an ARBITRARY per-bin SOL distribution from a CLI `--dist=w1,w2,…` spec (e.g. `1,1,8,1,1` = a spike on
 * bin #3). Bins are laid on the SOL side, anchored at the active bin. Reuses the tested `reanchorShape` BPS
 * math → no new fidelity-critical logic. Lets us drive COMPLEX leader shapes (more SOL on some bins).
 */
function customDistribution(spec: string, activeBin: number, solSide: 'X' | 'Y', ascendFrom?: number): WeightBin[] {
  const weights = spec.split(',').map((s) => Number(s.trim()));
  // Allow 0 weights (skip that bin → place SOL on specific bins, e.g. --dist=0,0,0,5); reject negatives/NaN.
  if (weights.length === 0 || weights.some((w) => !Number.isFinite(w) || w < 0) || !weights.some((w) => w > 0))
    throw new Error(`--dist needs non-negative weights with at least one > 0, got "${spec}"`);
  // Default: anchor at the active bin, laid on the SOL side. `ascendFrom` instead lays bins ASCENDING from a
  // given bin (used by `add` to target an EXISTING position's fixed range, since the active bin may have drifted
  // out of it). Either way the layout is contiguous + ascending after the sort below.
  const base = ascendFrom ?? activeBin;
  const dir = ascendFrom !== undefined ? 1 : solSide === 'X' ? 1 : -1;
  const synthetic = weights.map((w, i) => ({ binId: base + dir * i, amount: BigInt(Math.round(w * WEIGHT_SCALE)) }));
  const reanchored = reanchorShape(base, base, synthetic);
  // SDK by-weight wants bins in ascending, contiguous order (our descending SOL-Y layout would read as gaps).
  return reanchored.weights
    .map((wt) => ({ binId: wt.binId, xBps: solSide === 'X' ? wt.bps : 0, yBps: solSide === 'Y' ? wt.bps : 0 }))
    .sort((a, b) => a.binId - b.binId);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  console.log(`leader-test = ${leader.publicKey.toBase58()}`);

  if (cmd === 'pools') {
    try {
      const res = await fetch('https://dlmm-api.meteora.ag/pair/all');
      const all = (await res.json()) as Array<{ address: string; name: string; mint_x: string; mint_y: string; bin_step: number; liquidity: string }>;
      const solUsdc = all
        .filter((p) => (p.mint_x === SOL && p.mint_y === USDC) || (p.mint_x === USDC && p.mint_y === SOL))
        .sort((a, b) => Number(b.liquidity) - Number(a.liquidity))
        .slice(0, 8);
      if (solUsdc.length === 0) throw new Error('no SOL/USDC pool in the response');
      console.log('SOL/USDC pools (by liquidity):');
      for (const p of solUsdc) console.log(`  ${p.address}  binStep=${p.bin_step}  liq=$${Math.round(Number(p.liquidity))}  ${p.name}`);
    } catch (e) {
      console.log(`Meteora API unreachable (${(e as Error).message}). Grab a SOL/USDC pool on app.meteora.ag,`);
      console.log('then: leader-control open --pool=<address> --sol=0.1');
    }
    return;
  }

  if (cmd === 'sweep') {
    // Convert EVERY non-SOL token on leader-test back to SOL (classic SPL + Token-2022) — mirrors the bot's
    // wallet sweep, but signs directly with the leader-test key (a test wallet, not the copier). Recovers the
    // value locked as token (a wallet UI shows it in the total; getBalance shows only native SOL).
    const balances = await readAllOwnerTokenBalances(conn, leader.publicKey);
    const toSweep = planWalletSweep(balances, WSOL_MINT, 0n);
    if (toSweep.length === 0) {
      console.log('🧹 nothing to sweep — wallet is already all SOL');
      return;
    }
    for (const b of toSweep) {
      try {
        const quote = await getJupiterQuote(JUPITER_BASE, b.mint, b.amountRaw, SWEEP_SLIPPAGE_BPS);
        const txB64 = await buildJupiterSwapTx(JUPITER_BASE, quote, leader.publicKey.toBase58());
        const sigs = await signLandConfirm(Transaction.from(Buffer.from(txB64, 'base64')));
        console.log(`🧹 SWEEP ${b.mint} ${b.amountRaw} → ${Number(quote.outAmount) / 1e9} SOL sigs=${sigs.join(',')}`);
      } catch (e) {
        console.log(`⚠️ sweep failed for ${b.mint}: ${(e as Error).message}`);
      }
    }
    return;
  }

  if (cmd === 'positions') {
    // Enumerate ALL leader-test positions across every pool (find orphans locking SOL). `getBalance` only
    // shows free/native SOL; liquidity deposited in a position is locked → wallet UIs show the higher total.
    const positions = await readUserPositions(conn, leader.publicKey);
    if (positions.length === 0) console.log('no positions on any pool');
    for (const p of positions) console.log(`  pool=${p.pool} position=${p.position} range=[${p.lowerBinId},${p.upperBinId}]`);
    return;
  }

  const pool = arg('pool');
  if (!pool) throw new Error('--pool=<SOL/USDC address> required (cf. `leader-control pools`)');
  const pk = new PublicKey(pool);

  if (cmd === 'status') {
    const shape = await readLeaderPositionShape(conn, pk, leader.publicKey);
    console.log(shape ? `position ${shape.positionPubkey} range=[${shape.lowerBinId},${shape.upperBinId}] bins=${shape.perBin.length}` : 'no position');
    return;
  }

  if (cmd === 'close-all') {
    // Close EVERY leader position on the pool, including EMPTY ones (`close` only handles the first liquidity-bearing
    // position; an emptied-but-open position is invisible to it AND to readUserPositions). Enumerate via the SDK
    // (which lists empty positions too) and close each by pubkey+range.
    const pair = await createDlmmPair(conn, pk);
    const { userPositions } = await pair.getPositionsByUserAndLbPair(leader.publicKey);
    console.log(`close-all: ${userPositions.length} position(s) on ${pool}`);
    for (const p of userPositions) {
      const lower = p.positionData.lowerBinId;
      const upper = p.positionData.upperBinId;
      try {
        // Full positions: remove-all + close. EMPTY positions make removeLiquidity error → fall back to a close-only
        // (`closePositionIfEmpty`), so an emptied-but-open leader (the remove-to-zero edge) is still closed.
        const built = await buildCloseTx(conn, pk, leader.publicKey, p.publicKey, lower, upper);
        await signLandConfirm(built);
        console.log(`💥 closed ${p.publicKey.toBase58()} [${lower},${upper}]`);
      } catch (e) {
        try {
          const tx = await pair.closePositionIfEmpty({ owner: leader.publicKey, position: p });
          await signLandConfirm(tx);
          console.log(`💥 closed EMPTY ${p.publicKey.toBase58()} [${lower},${upper}]`);
        } catch (e2) {
          console.warn(`close-all: ${p.publicKey.toBase58()} → ${(e as Error).message} | empty: ${(e2 as Error).message}`);
        }
      }
    }
    return;
  }

  if (cmd === 'open') {
    const meta = await poolMeta(pool);
    const solSide = meta.solSide as 'X' | 'Y';
    const sol = BigInt(Math.round(Number(arg('sol') ?? '0.1') * 1e9));
    const position = Keypair.generate();
    if (process.argv.includes('--twosided')) {
      // Create a genuine TWO-SIDED leader position to copy: BUY the non-SOL token (ExactIn — ExactOut has no route
      // for Token-2022 memecoins) then deposit BOTH legs by strategy. --token = TARGET raw units; we deposit the
      // ACTUAL bought amount (ExactIn output is variable).
      const tokenMint = solSide === 'Y' ? meta.mintX : meta.mintY;
      const tokenRaw = BigInt(arg('token') ?? '5000000');
      const bought = await buyTokenExactIn(tokenMint, tokenRaw);
      const built = await buildOpenByStrategyTwoSided(conn, pk, leader.publicKey, position.publicKey, solSide, sol, bought, WIDTH_BINS, strategyTypeFromName(arg('strategy') ?? 'spot'));
      const sigs = await signLandConfirm(built, [position]);
      console.log(`🟢🟢 OPEN [two-sided ${arg('strategy') ?? 'spot'}] position=${position.publicKey.toBase58()} sol=${Number(sol) / 1e9} token=${tokenRaw} sigs=${sigs.join(',')}`);
      return;
    }
    const dist = arg('dist'); // custom per-bin weights, e.g. --dist=1,1,8,1,1,1,5,1
    if (dist) {
      const pair = await createDlmmPair(conn, pk);
      const active = (await pair.getActiveBin()).binId;
      const w = customDistribution(dist, active, solSide);
      const built = await buildOpenByWeight(conn, pk, leader.publicKey, position.publicKey, solSide === 'X' ? sol : 0n, solSide === 'Y' ? sol : 0n, w, pair);
      const sigs = await signLandConfirm(built, [position]);
      console.log(`🟢 OPEN [custom ${dist}] position=${position.publicKey.toBase58()} range=[${Math.min(...w.map((b) => b.binId))},${Math.max(...w.map((b) => b.binId))}] sigs=${sigs.join(',')}`);
      return;
    }
    const strategyName = arg('strategy') ?? 'spot'; // spot | bidask | curve
    const built = await buildOpenByStrategy(conn, pk, leader.publicKey, position.publicKey, solSide, sol, WIDTH_BINS, strategyTypeFromName(strategyName));
    const sigs = await signLandConfirm(built, [position]);
    console.log(`🟢 OPEN [${strategyName}] position=${position.publicKey.toBase58()} sigs=${sigs.join(',')}`);
    return;
  }

  const shape = await readLeaderPositionShape(conn, pk, leader.publicKey);
  if (!shape) throw new Error('no leader-test position on this pool');

  if (cmd === 'close') {
    const built = await buildCloseTx(conn, pk, leader.publicKey, new PublicKey(shape.positionPubkey), shape.lowerBinId, shape.upperBinId);
    console.log(`🔴 CLOSE sigs=${(await signLandConfirm(built)).join(',')}`);
    return;
  }
  if (cmd === 'add') {
    const meta = await poolMeta(pool);
    const solSide = meta.solSide as 'X' | 'Y';
    const sol = BigInt(Math.round(Number(arg('sol') ?? '0.05') * 1e9));
    if (process.argv.includes('--twosided')) {
      // GROW the leader's two-sided position: BUY token (ExactIn) then add BOTH legs within the position's fixed range.
      const tokenMint = solSide === 'Y' ? meta.mintX : meta.mintY;
      const tokenRaw = BigInt(arg('token') ?? '2000000');
      const bought = await buyTokenExactIn(tokenMint, tokenRaw);
      const built = await buildAddByStrategyTwoSided(conn, pk, leader.publicKey, new PublicKey(shape.positionPubkey), solSide, sol, bought, shape.lowerBinId, shape.upperBinId, strategyTypeFromName(arg('strategy') ?? 'spot'));
      console.log(`➕➕ ADD [two-sided] sol=${Number(sol) / 1e9} token=${tokenRaw} sigs=${(await signLandConfirm(built)).join(',')}`);
      return;
    }
    const dist = arg('dist'); // custom per-bin add, e.g. --dist=0,0,5,0,0 = add only on bin #3
    if (dist) {
      const pair = await createDlmmPair(conn, pk);
      const active = (await pair.getActiveBin()).binId;
      // Anchor the add ASCENDING from the position's lower bin so it always lands INSIDE the existing fixed range
      // (the active bin may have drifted out of it since the open → an active-anchored add would be out-of-range).
      const w = customDistribution(dist, active, solSide, shape.lowerBinId);
      const built = await buildAddByWeight(conn, pk, leader.publicKey, new PublicKey(shape.positionPubkey), solSide === 'X' ? sol : 0n, solSide === 'Y' ? sol : 0n, w, pair);
      console.log(`➕ ADD [custom ${dist}] ${arg('sol') ?? '0.05'} range=[${Math.min(...w.map((b) => b.binId))},${Math.max(...w.map((b) => b.binId))}] sigs=${(await signLandConfirm(built)).join(',')}`);
      return;
    }
    const built = await buildAddByStrategy(conn, pk, leader.publicKey, new PublicKey(shape.positionPubkey), solSide, sol, WIDTH_BINS, strategyTypeFromName(arg('strategy') ?? 'spot'));
    console.log(`➕ ADD ${arg('sol') ?? '0.05'} sigs=${(await signLandConfirm(built)).join(',')}`);
    return;
  }
  if (cmd === 'remove') {
    const bps = Number(arg('bps') ?? '3000');
    const fromBin = arg('frombin') ? Number(arg('frombin')) : shape.lowerBinId; // sub-range remove → tests per-bin trims
    const toBin = arg('tobin') ? Number(arg('tobin')) : shape.upperBinId;
    const built = await buildRemovePartial(conn, pk, leader.publicKey, new PublicKey(shape.positionPubkey), fromBin, toBin, bps);
    console.log(`➖ REMOVE ${bps}bps [${fromBin},${toBin}] sigs=${(await signLandConfirm(built)).join(',')}`);
    return;
  }
  if (cmd === 'claim') {
    const built = await buildClaimTx(conn, pk, leader.publicKey, shape.positionPubkey);
    console.log(`💰 CLAIM sigs=${(await signLandConfirm(built)).join(',')}`);
    return;
  }
  throw new Error(`unknown command: ${cmd} (pools|status|open|close|claim)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('error:', (e as Error).message);
    process.exit(1);
  });
