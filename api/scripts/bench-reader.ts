/**
 * Copy-bot · on-chain bench READER (BUNDLED CJS — the @meteora-ag/dlmm SDK only loads bundled, never under
 * vitest/ESM). The test harness execs this for every SDK-touching read and parses the JSON, keeping the SDK out
 * of the vitest process. Subcommands:
 *   positions <owner>                                   → JSON [{position,pool,lowerBinId,upperBinId}]
 *   fidelity  <pool> <leaderOwner> <lPos> <copyOwner> <cPos> → JSON FidelityResult (or {missing:true,...})
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { readLeaderPositionShape, readUserPositions } from '@/infrastructure/solana/dlmm/leader-position-reader';
import { OnchainPoolMetaReader } from '@/infrastructure/solana/dlmm/pool-meta';
import { compareFidelity } from '@/infrastructure/solana/dlmm/shape-fidelity';

const conn = new Connection(process.env.SOLANA_HTTP_URL ?? '', 'confirmed');
const [cmd, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  if (cmd === 'positions') {
    const owner = rest[0];
    if (!owner) throw new Error('positions <owner>');
    console.log(JSON.stringify(await readUserPositions(conn, new PublicKey(owner))));
    return;
  }
  if (cmd === 'fidelity') {
    const [pool, leaderOwner, lPos, copyOwner, cPos] = rest;
    if (!pool || !leaderOwner || !lPos || !copyOwner || !cPos) throw new Error('fidelity <pool> <leaderOwner> <lPos> <copyOwner> <cPos>');
    const meta = await new OnchainPoolMetaReader(conn).loadPoolMeta(pool);
    if (!meta?.solSide) throw new Error(`pool ${pool} not SOL-paired`);
    const lead = await readLeaderPositionShape(conn, new PublicKey(pool), new PublicKey(leaderOwner), lPos);
    const copy = await readLeaderPositionShape(conn, new PublicKey(pool), new PublicKey(copyOwner), cPos);
    if (!lead || !copy) {
      console.log(JSON.stringify({ missing: true, lead: !!lead, copy: !!copy }));
      return;
    }
    const r = compareFidelity(
      { activeBinId: lead.activeBinId, perBin: lead.perBin },
      { activeBinId: copy.activeBinId, perBin: copy.perBin },
      meta.solSide,
      meta.binStep,
    );
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === 'shape') {
    // shape <pool> <owner> <pos> → per-bin {offset-from-active, sol, token} (diagnostic for selective reshape).
    const [pool, owner, pos] = rest;
    if (!pool || !owner || !pos) throw new Error('shape <pool> <owner> <pos>');
    const meta = await new OnchainPoolMetaReader(conn).loadPoolMeta(pool);
    if (!meta?.solSide) throw new Error(`pool ${pool} not SOL-paired`);
    const s = await readLeaderPositionShape(conn, new PublicKey(pool), new PublicKey(owner), pos);
    if (!s) {
      console.log(JSON.stringify({ missing: true }));
      return;
    }
    const bins = s.perBin.map((b) => ({
      off: b.binId - s.activeBinId,
      sol: Number(meta.solSide === 'Y' ? b.y : b.x),
      tok: Number(meta.solSide === 'Y' ? b.x : b.y),
    }));
    console.log(JSON.stringify({ activeBinId: s.activeBinId, lowerBinId: s.lowerBinId, upperBinId: s.upperBinId, bins }));
    return;
  }
  throw new Error(`unknown bench-reader command: ${cmd}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(JSON.stringify({ error: (e as Error).message }));
    process.exit(1);
  });
