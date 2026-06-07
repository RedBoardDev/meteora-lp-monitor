import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS wallets (
     address TEXT PRIMARY KEY,
     label TEXT NOT NULL DEFAULT '',
     color TEXT,
     created_at INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS positions (
     position_address TEXT PRIMARY KEY,
     wallet TEXT NOT NULL,
     pool_address TEXT NOT NULL,
     token_x TEXT, token_y TEXT, token_x_mint TEXT,
     status TEXT NOT NULL,
     pnl_sol REAL, pnl_pct_sol REAL,
     size_sol REAL, deposit_sol REAL, withdraw_sol REAL,
     claimed_fees_sol REAL, unclaimed_fees_sol REAL,
     min_price REAL, max_price REAL, pool_price REAL,
     range_status TEXT,
     oor_since INTEGER,
     opened_at INTEGER, closed_at INTEGER, duration_seconds INTEGER,
     updated_at INTEGER NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_positions_wallet_status ON positions(wallet, status);`,
  `CREATE INDEX IF NOT EXISTS idx_positions_closed_at ON positions(wallet, closed_at);`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     wallet TEXT, position_address TEXT,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     notified INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS notif_rules (
     wallet TEXT,
     event_kind TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     mode TEXT NOT NULL DEFAULT 'single',
     threshold REAL,
     oor_minutes INTEGER,
     PRIMARY KEY (wallet, event_kind)
   );`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS sync_state (
     wallet TEXT PRIMARY KEY,
     last_full_sync_at INTEGER,
     last_closed_ts INTEGER
   );`,
];

// Additive columns applied to pre-existing tables (CREATE IF NOT EXISTS won't add them).
const ADDED_COLUMNS: { table: string; column: string; def: string }[] = [
  { table: 'positions', column: 'token_x_mint', def: 'TEXT' },
  // Residual token revalued at the live market (Jupiter) price at close. Kept separate from
  // pnl_sol so the periodic Meteora resync (pool-price) never overwrites the market reprice.
  { table: 'positions', column: 'market_pnl_sol', def: 'REAL' },
];

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) db.exec(sql);
  for (const { table, column, def } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
  }
  return db;
}
