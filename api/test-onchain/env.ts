/**
 * Copy-bot · on-chain test bench — shared config + connection. Env (RPC, keys) is loaded by `node --env-file`
 * in the `test:onchain` script (we never read .env ourselves). The bot (brain+coffre) is spawned by global-setup;
 * tests drive the leader (leader-control CLI) + read the chain here, never touching the bot process directly.
 */
import { Connection, PublicKey } from '@solana/web3.js';

/** Both test wallets (leader-test = the controllable "leader"; copier-test = the bot's copy wallet). */
export const LEADER_TEST = new PublicKey('6nhwvUjRe5a3KC9BmURxMuaf9EQ7MUHDnfsQ2NfVQjc9');
export const COPIER_TEST = new PublicKey('Ybbt2Td4TjxwpzvuicbP9ANizBwAJzqjuRmRrvDh9zz');

/** Test pools: a STABLE SOL/USDC (clean fidelity, low arb) + a VOLATILE SOL/<Token-2022 pump> (realistic). */
export const POOL_STABLE = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6';
export const POOL_VOLATILE = 'Hzsx5pCjvPAYhXr6vhAV35C7KSTfacvyQEcE6P3PjRep';
// A volatile COIN(pump.fun)/SOL pool (tokenX=9cRCn…pump, tokenY=WSOL, binStep=100/1%) — SOL-paired so the bot copies
// it. User-requested coverage beyond the stable SOL/USDC: a wide-binStep, low-liquidity coin regime.
export const POOL_COIN_SOL = 'AUvX4hEMi9t43aqovA5tEAA5AZ7yugcpHa8SkJVEoEKa';

/** Minimum SOL each wallet must hold for the suite to run (else tests SKIP, not fail). */
export const MIN_LEADER_SOL = 0.15;
export const MIN_COPIER_SOL = 0.15;

export const onchainEnabled = (): boolean => process.env.RUN_ONCHAIN === 'true';

export function connection(): Connection {
  const url = process.env.SOLANA_HTTP_URL;
  if (!url) throw new Error('SOLANA_HTTP_URL missing — run via the test:onchain script (node --env-file=../.env)');
  return new Connection(url, 'confirmed');
}

export const solBalance = async (conn: Connection, owner: PublicKey): Promise<number> => (await conn.getBalance(owner)) / 1e9;
