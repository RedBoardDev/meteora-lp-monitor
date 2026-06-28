/**
 * Copy-bot · config-management CLI. Reads/edits the DB-backed runtime config (settings → copybot.config) WITHOUT
 * the web, then publishes the `copybot:control` ping so a running bot reloads instantly.
 *
 *   node --import tsx --env-file=../.env scripts/copybot-config.ts <command>
 *
 *   show                     pretty-print the full config
 *   get <path>               read a dotted path (e.g. user.sizing.tradeRatioPct, leaders.0.enabled)
 *   set <path> <value>       set a path (value coerced: 100, true, "medium", '["A","B"]'); validated then saved
 *   add-leader <address>     follow a new leader (≤ MAX_LEADERS)
 *   remove-leader <address>  stop following a leader
 *   import <file>            replace the config from a JSON file (validated)
 *   export [file]            write the config JSON to a file, or stdout
 *
 * Pure edit logic lives in domain/copybot/config (getAtPath/setAtPath/coerceValue/addLeader/removeLeader); this is
 * the thin I/O shell. No Solana SDK → runs under tsx.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pino } from 'pino';
import { ConfigStore } from '@/copybot/config-store';
import {
  addLeader,
  coerceValue,
  CopybotConfigSchema,
  getAtPath,
  isValidConfigBlob,
  parseConfig,
  removeLeader,
  setAtPath,
} from '@/domain/copybot/config';
import { ControlChannel } from '@/infrastructure/bus/control-channel';
import { openDatabase } from '@/infrastructure/persistence/database';
import type { CopybotConfig } from '@/domain/copybot/config';

const DB_URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6385';

function required(value: string | undefined, name: string): string {
  if (value === undefined) {
    console.error(`missing argument: <${name}>`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const [cmd, a0, a1] = process.argv.slice(2);
  const log = pino({ level: 'warn' }); // quiet — CLI output goes to console
  const store = new ConfigStore(openDatabase(DB_URL), log);
  const config = await store.seedIfAbsent();

  // Validate, persist, then ping the running bot to reload immediately (5s poll is the backstop).
  const persist = async (next: CopybotConfig): Promise<void> => {
    const valid = CopybotConfigSchema.parse(next); // throws ZodError on invalid → never persist junk
    await store.save(valid);
    const control = ControlChannel.connect(REDIS_URL);
    await control.publish({ type: 'config-changed' });
    await control.quit();
    console.log('✅ config saved + control ping published');
  };

  switch (cmd) {
    case 'show':
      console.log(JSON.stringify(config, null, 2));
      break;
    case 'get':
      console.log(JSON.stringify(getAtPath(config, required(a0, 'path')), null, 2));
      break;
    case 'set':
      await persist(setAtPath(config, required(a0, 'path'), coerceValue(required(a1, 'value'))));
      break;
    case 'add-leader':
      await persist(addLeader(config, required(a0, 'address')));
      break;
    case 'remove-leader':
      await persist(removeLeader(config, required(a0, 'address')));
      break;
    case 'import': {
      const raw = readFileSync(required(a0, 'file'), 'utf8');
      if (!isValidConfigBlob(raw)) throw new Error('invalid config file (does not match the config schema)');
      await persist(parseConfig(raw));
      break;
    }
    case 'export': {
      const out = JSON.stringify(config, null, 2);
      if (a0) {
        writeFileSync(a0, out);
        console.log(`exported to ${a0}`);
      } else console.log(out);
      break;
    }
    default:
      console.error('usage: copybot-config <show|get|set|add-leader|remove-leader|import|export> [args]');
      process.exit(cmd ? 1 : 0);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
