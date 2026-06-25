/**
 * Copy-bot · on-chain bench — global setup (runs ONCE in the main process before the worker). Builds the bot and
 * checks both wallets are funded (else SKIPS the suite cleanly — never a false failure), then sets ONCHAIN_READY.
 * The bot (coffre+brain) is spawned/killed/restarted by bot-controller IN THE WORKER (so chaos tests can control
 * it). The teardown here is a belt-and-suspenders pkill of any bot the worker may have left behind.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Connection } from '@solana/web3.js';
import { COPIER_TEST, LEADER_TEST, MIN_COPIER_SOL, MIN_LEADER_SOL } from './env';

const execFileAsync = promisify(execFile);

export default async function setup(): Promise<() => Promise<void>> {
  const url = process.env.SOLANA_HTTP_URL;
  if (!url) throw new Error('SOLANA_HTTP_URL missing — run via `yarn test:onchain` (node --env-file=../.env)');
  const conn = new Connection(url, 'confirmed');

  const lead = (await conn.getBalance(LEADER_TEST)) / 1e9;
  const copier = (await conn.getBalance(COPIER_TEST)) / 1e9;
  if (lead < MIN_LEADER_SOL || copier < MIN_COPIER_SOL) {
    console.warn(`⏭️  on-chain suite SKIPPED — underfunded: leader-test=${lead.toFixed(3)} (need ${MIN_LEADER_SOL}), copier-test=${copier.toFixed(3)} (need ${MIN_COPIER_SOL})`);
    process.env.ONCHAIN_READY = 'false';
    return async () => undefined;
  }

  console.log(`🔨 building bot…  (leader-test=${lead.toFixed(3)} SOL, copier-test=${copier.toFixed(3)} SOL)`);
  await execFileAsync('yarn', ['bot:build'], { env: process.env, maxBuffer: 1 << 22 });
  process.env.ONCHAIN_READY = 'true';

  return async () => {
    await execFileAsync('pkill', ['-9', '-f', 'copybot/(coffre|brain)']).catch(() => undefined); // kill any bot the worker left
  };
}
